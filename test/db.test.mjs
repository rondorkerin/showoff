import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PGlite } from '@electric-sql/pglite'
import { vector } from '@electric-sql/pglite-pgvector'
import { MIGRATIONS } from '../src/main/db/migrations.ts'

/**
 * Proves the real thing: actual Postgres, actual pgvector, actual migrations,
 * running the same SQL the app ships.
 */
async function freshDb() {
  const dir = mkdtempSync(join(tmpdir(), 'showoff-db-'))
  const db = new PGlite(dir, { extensions: { vector } })
  await db.waitReady
  await db.exec(`CREATE TABLE IF NOT EXISTS schema_migrations (
    id INTEGER PRIMARY KEY, name TEXT NOT NULL, applied_at TIMESTAMPTZ NOT NULL DEFAULT now());`)
  for (const m of MIGRATIONS) {
    await db.exec('BEGIN')
    await db.exec(m.sql)
    await db.query('INSERT INTO schema_migrations (id, name) VALUES ($1, $2)', [m.id, m.name])
    await db.exec('COMMIT')
  }
  return { db, dir }
}

test('migrations apply cleanly and it is really postgres', async () => {
  const { db, dir } = await freshDb()
  try {
    const v = await db.query('SELECT version() AS v')
    assert.match(v.rows[0].v, /PostgreSQL/, 'should be genuine Postgres')

    const applied = await db.query('SELECT id FROM schema_migrations ORDER BY id')
    assert.deepEqual(
      applied.rows.map((r) => Number(r.id)),
      MIGRATIONS.map((m) => m.id)
    )

    const tables = await db.query(
      `SELECT table_name FROM information_schema.tables WHERE table_schema='public' ORDER BY 1`
    )
    const names = tables.rows.map((r) => r.table_name)
    for (const t of [
      'projects',
      'recordings',
      'tracks',
      'transcripts',
      'transcript_segments',
      'notes',
      'clips',
      'clip_renders',
      'embeddings',
      'jobs',
      'recording_answers'
    ]) {
      assert.ok(names.includes(t), `missing table ${t}`)
    }
  } finally {
    await db.close()
    rmSync(dir, { recursive: true, force: true })
  }
})

test('migrations are idempotent when re-run', async () => {
  const { db, dir } = await freshDb()
  try {
    for (const m of MIGRATIONS) await db.exec(m.sql)
    const r = await db.query('SELECT count(*)::int AS c FROM recordings')
    assert.equal(r.rows[0].c, 0)
  } finally {
    await db.close()
    rmSync(dir, { recursive: true, force: true })
  }
})

test('pgvector similarity search works end to end', async () => {
  const { db, dir } = await freshDb()
  try {
    await db.query(`INSERT INTO recordings (id, title, dir) VALUES ('r1','Test','/tmp')`)
    const mk = (seed) =>
      '[' +
      Array.from({ length: 768 }, (_, i) => (Math.sin(i * seed) + 1) / 2).join(',') +
      ']'

    await db.query(
      `INSERT INTO embeddings (id, recording_id, kind, text, embedding) VALUES ($1,$2,$3,$4,$5)`,
      ['e1', 'r1', 'segment', 'we shipped the auth flow today', mk(0.5)]
    )
    await db.query(
      `INSERT INTO embeddings (id, recording_id, kind, text, embedding) VALUES ($1,$2,$3,$4,$5)`,
      ['e2', 'r1', 'segment', 'the video pipeline is rendering', mk(1.7)]
    )

    const res = await db.query(
      `SELECT id, 1 - (embedding <=> $1) AS score FROM embeddings ORDER BY embedding <=> $1 LIMIT 2`,
      [mk(0.5)]
    )
    assert.equal(res.rows[0].id, 'e1', 'nearest neighbour should be the matching vector')
    assert.ok(res.rows[0].score > res.rows[1].score)
  } finally {
    await db.close()
    rmSync(dir, { recursive: true, force: true })
  }
})

test('full text search index is usable', async () => {
  const { db, dir } = await freshDb()
  try {
    await db.query(`INSERT INTO recordings (id, title, dir) VALUES ('r1','Test','/tmp')`)
    await db.query(
      `INSERT INTO transcripts (id, recording_id, provider, text) VALUES ('t1','r1','test',$1)`,
      ['Today I wired up the ffmpeg render pipeline and it finally cut a clip']
    )
    const res = await db.query(
      `SELECT id FROM transcripts WHERE to_tsvector('english', text) @@ plainto_tsquery('english', $1)`,
      ['ffmpeg pipeline']
    )
    assert.equal(res.rows.length, 1)
  } finally {
    await db.close()
    rmSync(dir, { recursive: true, force: true })
  }
})

test('cascade delete removes dependent rows', async () => {
  const { db, dir } = await freshDb()
  try {
    await db.query(`INSERT INTO recordings (id, title, dir) VALUES ('r1','Test','/tmp')`)
    await db.query(
      `INSERT INTO clips (id, recording_id, platform, start_ms, end_ms) VALUES ('c1','r1','x',0,1000)`
    )
    await db.query(
      `INSERT INTO clip_renders (id, clip_id, path, width, height, duration_ms) VALUES ('cr1','c1','/tmp/a.mp4',1280,720,1000)`
    )
    await db.query(`DELETE FROM recordings WHERE id='r1'`)
    const clips = await db.query('SELECT count(*)::int AS c FROM clips')
    const renders = await db.query('SELECT count(*)::int AS c FROM clip_renders')
    assert.equal(clips.rows[0].c, 0)
    assert.equal(renders.rows[0].c, 0, 'renders must cascade through clips')
  } finally {
    await db.close()
    rmSync(dir, { recursive: true, force: true })
  }
})
