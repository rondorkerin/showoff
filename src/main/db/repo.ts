import { newId, one, query } from './index.ts'
import type {
  Clip,
  ClipRender,
  Job,
  Note,
  Project,
  Recording,
  Track,
  TranscriptSegment,
  TrackKind
} from '../../shared/types.ts'
import type { PlatformId } from '../../shared/platforms.ts'

/* ------------------------------------------------------------------ projects */

export async function listProjects(): Promise<Project[]> {
  return query<Project>('SELECT * FROM projects ORDER BY name')
}

export async function createProject(name: string, context = ''): Promise<Project> {
  const id = newId('prj')
  await query('INSERT INTO projects (id, name, context) VALUES ($1,$2,$3)', [id, name, context])
  return (await one<Project>('SELECT * FROM projects WHERE id=$1', [id]))!
}

export async function updateProject(
  id: string,
  patch: { name?: string; context?: string }
): Promise<Project | null> {
  await query(
    'UPDATE projects SET name=COALESCE($2,name), context=COALESCE($3,context) WHERE id=$1',
    [id, patch.name ?? null, patch.context ?? null]
  )
  return one<Project>('SELECT * FROM projects WHERE id=$1', [id])
}

export async function deleteProject(id: string): Promise<void> {
  await query('DELETE FROM projects WHERE id=$1', [id])
}

/* ---------------------------------------------------------------- recordings */

export async function createRecording(input: {
  title: string
  dir: string
  projectId: string | null
}): Promise<Recording> {
  const id = newId('rec')
  await query(
    'INSERT INTO recordings (id, project_id, title, dir, status) VALUES ($1,$2,$3,$4,$5)',
    [id, input.projectId, input.title, input.dir, 'recording']
  )
  return (await one<Recording>('SELECT * FROM recordings WHERE id=$1', [id]))!
}

export async function finishRecording(
  id: string,
  patch: {
    durationMs: number
    width: number
    height: number
    posterPath: string | null
  }
): Promise<void> {
  await query(
    `UPDATE recordings SET duration_ms=$2, width=$3, height=$4, poster_path=$5,
       status='ready', error=NULL WHERE id=$1`,
    [id, patch.durationMs, patch.width, patch.height, patch.posterPath]
  )
}

export async function failRecording(id: string, error: string): Promise<void> {
  await query(`UPDATE recordings SET status='failed', error=$2 WHERE id=$1`, [id, error])
}

export async function getRecording(id: string): Promise<Recording | null> {
  return one<Recording>('SELECT * FROM recordings WHERE id=$1', [id])
}

export async function listRecordings(projectId?: string | null): Promise<Recording[]> {
  if (projectId) {
    return query<Recording>(
      'SELECT * FROM recordings WHERE project_id=$1 ORDER BY created_at DESC',
      [projectId]
    )
  }
  return query<Recording>('SELECT * FROM recordings ORDER BY created_at DESC')
}

export async function updateRecording(
  id: string,
  patch: { title?: string; projectId?: string | null }
): Promise<void> {
  if (patch.title !== undefined) {
    await query('UPDATE recordings SET title=$2 WHERE id=$1', [id, patch.title])
  }
  if (patch.projectId !== undefined) {
    await query('UPDATE recordings SET project_id=$2 WHERE id=$1', [id, patch.projectId])
  }
}

export async function deleteRecording(id: string): Promise<void> {
  await query('DELETE FROM recordings WHERE id=$1', [id])
}

/* -------------------------------------------------------------------- tracks */

export async function addTrack(
  recordingId: string,
  kind: TrackKind,
  path: string,
  durationMs: number | null
): Promise<Track> {
  const id = newId('trk')
  await query(
    'INSERT INTO tracks (id, recording_id, kind, path, duration_ms) VALUES ($1,$2,$3,$4,$5)',
    [id, recordingId, kind, path, durationMs]
  )
  return (await one<Track>('SELECT * FROM tracks WHERE id=$1', [id]))!
}

export async function listTracks(recordingId: string): Promise<Track[]> {
  return query<Track>('SELECT * FROM tracks WHERE recording_id=$1 ORDER BY created_at', [
    recordingId
  ])
}

export async function getTrack(recordingId: string, kind: TrackKind): Promise<Track | null> {
  return one<Track>('SELECT * FROM tracks WHERE recording_id=$1 AND kind=$2 LIMIT 1', [
    recordingId,
    kind
  ])
}

/* --------------------------------------------------------------- transcripts */

export async function saveTranscript(
  recordingId: string,
  provider: string,
  language: string,
  text: string,
  segments: Array<{ startMs: number; endMs: number; text: string }>
): Promise<string> {
  // One transcript per recording: a re-run replaces the old one rather than
  // accumulating duplicates that would double up in search.
  await query('DELETE FROM transcripts WHERE recording_id=$1', [recordingId])
  const id = newId('txt')
  await query(
    'INSERT INTO transcripts (id, recording_id, provider, language, text) VALUES ($1,$2,$3,$4,$5)',
    [id, recordingId, provider, language, text]
  )
  for (let i = 0; i < segments.length; i++) {
    const s = segments[i]
    await query(
      `INSERT INTO transcript_segments (id, transcript_id, idx, start_ms, end_ms, text)
       VALUES ($1,$2,$3,$4,$5,$6)`,
      [newId('seg'), id, i, s.startMs, s.endMs, s.text]
    )
  }
  return id
}

export async function getTranscript(
  recordingId: string
): Promise<{ id: string; provider: string; text: string; segments: TranscriptSegment[] } | null> {
  const t = await one<{ id: string; provider: string; text: string }>(
    'SELECT id, provider, text FROM transcripts WHERE recording_id=$1 ORDER BY created_at DESC LIMIT 1',
    [recordingId]
  )
  if (!t) return null
  const segments = await query<TranscriptSegment>(
    'SELECT * FROM transcript_segments WHERE transcript_id=$1 ORDER BY idx',
    [t.id]
  )
  return { ...t, segments }
}

/* ------------------------------------------------------------------- answers */

export async function saveAnswers(
  recordingId: string,
  pairs: Array<{ question: string; answer: string }>
): Promise<void> {
  await query('DELETE FROM recording_answers WHERE recording_id=$1', [recordingId])
  for (const p of pairs) {
    await query(
      'INSERT INTO recording_answers (id, recording_id, question, answer) VALUES ($1,$2,$3,$4)',
      [newId('ans'), recordingId, p.question, p.answer]
    )
  }
}

export async function getAnswers(
  recordingId: string
): Promise<Array<{ question: string; answer: string }>> {
  return query<{ question: string; answer: string }>(
    'SELECT question, answer FROM recording_answers WHERE recording_id=$1 ORDER BY created_at',
    [recordingId]
  )
}

/* --------------------------------------------------------------------- clips */

export async function replaceClips(
  recordingId: string,
  clips: Array<{
    platform: PlatformId
    title: string
    description: string
    hashtags: string[]
    hook: string
    reason: string
    score: number
    startMs: number
    endMs: number
  }>
): Promise<Clip[]> {
  await query('DELETE FROM clips WHERE recording_id=$1', [recordingId])
  const created: Clip[] = []
  for (let i = 0; i < clips.length; i++) {
    const c = clips[i]
    const id = newId('clp')
    await query(
      `INSERT INTO clips (id, recording_id, platform, title, description, hashtags, hook, reason, score, start_ms, end_ms, rank)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)`,
      [
        id,
        recordingId,
        c.platform,
        c.title,
        c.description,
        JSON.stringify(c.hashtags),
        c.hook,
        c.reason,
        c.score,
        c.startMs,
        c.endMs,
        i
      ]
    )
    created.push((await one<Clip>('SELECT * FROM clips WHERE id=$1', [id]))!)
  }
  return created
}

export async function listClips(recordingId: string): Promise<Clip[]> {
  return query<Clip>('SELECT * FROM clips WHERE recording_id=$1 ORDER BY rank', [recordingId])
}

export async function getClip(id: string): Promise<Clip | null> {
  return one<Clip>('SELECT * FROM clips WHERE id=$1', [id])
}

export async function updateClip(
  id: string,
  patch: { title?: string; description?: string; hashtags?: string[] }
): Promise<void> {
  if (patch.title !== undefined) await query('UPDATE clips SET title=$2 WHERE id=$1', [id, patch.title])
  if (patch.description !== undefined)
    await query('UPDATE clips SET description=$2 WHERE id=$1', [id, patch.description])
  if (patch.hashtags !== undefined)
    await query('UPDATE clips SET hashtags=$2 WHERE id=$1', [id, JSON.stringify(patch.hashtags)])
}

export async function deleteClip(id: string): Promise<void> {
  await query('DELETE FROM clips WHERE id=$1', [id])
}

export async function addRender(
  clipId: string,
  r: {
    path: string
    posterPath: string | null
    width: number
    height: number
    durationMs: number
    bytes: number
    captions: boolean
    webcamPip: boolean
  }
): Promise<ClipRender> {
  await query('DELETE FROM clip_renders WHERE clip_id=$1', [clipId])
  const id = newId('rnd')
  await query(
    `INSERT INTO clip_renders (id, clip_id, path, poster_path, width, height, duration_ms, bytes, captions, webcam_pip)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
    [
      id,
      clipId,
      r.path,
      r.posterPath,
      r.width,
      r.height,
      r.durationMs,
      r.bytes,
      r.captions,
      r.webcamPip
    ]
  )
  return (await one<ClipRender>('SELECT * FROM clip_renders WHERE id=$1', [id]))!
}

export async function listRenders(recordingId: string): Promise<ClipRender[]> {
  return query<ClipRender>(
    `SELECT r.* FROM clip_renders r JOIN clips c ON c.id=r.clip_id WHERE c.recording_id=$1`,
    [recordingId]
  )
}

export async function getRender(clipId: string): Promise<ClipRender | null> {
  return one<ClipRender>('SELECT * FROM clip_renders WHERE clip_id=$1 ORDER BY created_at DESC LIMIT 1', [
    clipId
  ])
}

/* --------------------------------------------------------------------- notes */

export async function upsertRecordingNote(
  recordingId: string,
  title: string,
  body: string
): Promise<Note> {
  const existing = await one<Note>('SELECT * FROM notes WHERE recording_id=$1 LIMIT 1', [
    recordingId
  ])
  if (existing) {
    await query('UPDATE notes SET title=$2, body=$3, updated_at=now() WHERE id=$1', [
      existing.id,
      title,
      body
    ])
    return (await one<Note>('SELECT * FROM notes WHERE id=$1', [existing.id]))!
  }
  const id = newId('nte')
  await query('INSERT INTO notes (id, recording_id, title, body) VALUES ($1,$2,$3,$4)', [
    id,
    recordingId,
    title,
    body
  ])
  return (await one<Note>('SELECT * FROM notes WHERE id=$1', [id]))!
}

export async function getRecordingNote(recordingId: string): Promise<Note | null> {
  return one<Note>('SELECT * FROM notes WHERE recording_id=$1 LIMIT 1', [recordingId])
}

/* ---------------------------------------------------------------------- tags */

export async function setRecordingTags(recordingId: string, names: string[]): Promise<void> {
  await query('DELETE FROM recording_tags WHERE recording_id=$1', [recordingId])
  for (const raw of names) {
    const name = raw.trim().toLowerCase()
    if (!name) continue
    let tag = await one<{ id: string }>('SELECT id FROM tags WHERE name=$1', [name])
    if (!tag) {
      const id = newId('tag')
      await query('INSERT INTO tags (id, name) VALUES ($1,$2) ON CONFLICT (name) DO NOTHING', [
        id,
        name
      ])
      tag = await one<{ id: string }>('SELECT id FROM tags WHERE name=$1', [name])
    }
    if (tag) {
      await query(
        'INSERT INTO recording_tags (recording_id, tag_id) VALUES ($1,$2) ON CONFLICT DO NOTHING',
        [recordingId, tag.id]
      )
    }
  }
}

export async function getRecordingTags(recordingId: string): Promise<string[]> {
  const rows = await query<{ name: string }>(
    `SELECT t.name FROM tags t JOIN recording_tags rt ON rt.tag_id=t.id
     WHERE rt.recording_id=$1 ORDER BY t.name`,
    [recordingId]
  )
  return rows.map((r) => r.name)
}

export async function listAllTags(): Promise<string[]> {
  const rows = await query<{ name: string }>('SELECT name FROM tags ORDER BY name')
  return rows.map((r) => r.name)
}

/* ---------------------------------------------------------------------- jobs */

export async function createJob(recordingId: string | null, kind: string): Promise<Job> {
  const id = newId('job')
  await query('INSERT INTO jobs (id, recording_id, kind, status) VALUES ($1,$2,$3,$4)', [
    id,
    recordingId,
    kind,
    'queued'
  ])
  return (await one<Job>('SELECT * FROM jobs WHERE id=$1', [id]))!
}

export async function updateJob(
  id: string,
  patch: { status?: string; stage?: string; progress?: number; error?: string | null }
): Promise<void> {
  await query(
    `UPDATE jobs SET
       status   = COALESCE($2, status),
       stage    = COALESCE($3, stage),
       progress = COALESCE($4, progress),
       error    = $5,
       updated_at = now()
     WHERE id=$1`,
    [id, patch.status ?? null, patch.stage ?? null, patch.progress ?? null, patch.error ?? null]
  )
}

export async function latestJob(recordingId: string): Promise<Job | null> {
  return one<Job>('SELECT * FROM jobs WHERE recording_id=$1 ORDER BY created_at DESC LIMIT 1', [
    recordingId
  ])
}

/* ---------------------------------------------------------------- embeddings */

export async function saveEmbedding(
  recordingId: string,
  kind: string,
  refId: string | null,
  text: string,
  startMs: number | null,
  endMs: number | null,
  embedding: number[] | null
): Promise<void> {
  await query(
    `INSERT INTO embeddings (id, recording_id, kind, ref_id, text, start_ms, end_ms, embedding)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
    [
      newId('emb'),
      recordingId,
      kind,
      refId,
      text,
      startMs,
      endMs,
      embedding ? `[${embedding.join(',')}]` : null
    ]
  )
}

export async function clearEmbeddings(recordingId: string): Promise<void> {
  await query('DELETE FROM embeddings WHERE recording_id=$1', [recordingId])
}

export interface SearchHit {
  recording_id: string
  recording_title: string
  kind: string
  text: string
  start_ms: number | null
  score: number
  source: 'semantic' | 'text'
}

/**
 * Lexical and semantic search, merged. Exact strings (a product name, an error
 * message) are what people actually type and embeddings are weak at those, so
 * the text index carries equal weight rather than being a fallback.
 */
export async function searchKnowledge(
  q: string,
  embedding: number[] | null,
  limit = 30
): Promise<SearchHit[]> {
  const hits: SearchHit[] = []

  const textRows = await query<SearchHit>(
    `SELECT e.recording_id, r.title AS recording_title, e.kind, e.text, e.start_ms,
            ts_rank(to_tsvector('english', e.text), plainto_tsquery('english', $1)) AS score
       FROM embeddings e JOIN recordings r ON r.id = e.recording_id
      WHERE to_tsvector('english', e.text) @@ plainto_tsquery('english', $1)
      ORDER BY score DESC LIMIT $2`,
    [q, limit]
  )
  hits.push(...textRows.map((r) => ({ ...r, score: Number(r.score), source: 'text' as const })))

  if (embedding && embedding.length > 0) {
    const vec = `[${embedding.join(',')}]`
    const vecRows = await query<SearchHit>(
      `SELECT e.recording_id, r.title AS recording_title, e.kind, e.text, e.start_ms,
              1 - (e.embedding <=> $1) AS score
         FROM embeddings e JOIN recordings r ON r.id = e.recording_id
        WHERE e.embedding IS NOT NULL
        ORDER BY e.embedding <=> $1 LIMIT $2`,
      [vec, limit]
    )
    hits.push(
      ...vecRows
        .map((r) => ({ ...r, score: Number(r.score), source: 'semantic' as const }))
        .filter((r) => r.score > 0.25)
    )
  }

  // Same passage found by both routes is one result, keeping the better score.
  const seen = new Map<string, SearchHit>()
  for (const h of hits) {
    const key = `${h.recording_id}:${h.start_ms ?? 'x'}:${h.text.slice(0, 40)}`
    const prev = seen.get(key)
    if (!prev || h.score > prev.score) seen.set(key, h)
  }
  return [...seen.values()].sort((a, b) => b.score - a.score).slice(0, limit)
}

export async function recordingStats(): Promise<{
  recordings: number
  clips: number
  minutes: number
}> {
  const r = await one<{ recordings: string; clips: string; ms: string }>(
    `SELECT
       (SELECT count(*) FROM recordings)                AS recordings,
       (SELECT count(*) FROM clips)                     AS clips,
       (SELECT COALESCE(sum(duration_ms),0) FROM recordings) AS ms`
  )
  return {
    recordings: Number(r?.recordings ?? 0),
    clips: Number(r?.clips ?? 0),
    minutes: Math.round(Number(r?.ms ?? 0) / 60000)
  }
}
