import { app } from 'electron'
import { join } from 'node:path'
import { mkdirSync } from 'node:fs'
import { PGlite } from '@electric-sql/pglite'
import { vector } from '@electric-sql/pglite-pgvector'
import { MIGRATIONS } from './migrations.ts'
import { DbMigrationError } from '../../shared/errors.ts'
import { log } from './../log.ts'

let db: PGlite | null = null
let ready: Promise<PGlite> | null = null

/**
 * Real Postgres, compiled to WASM, running in-process. This is what lets the
 * app ship a Postgres knowledgebase without asking anyone to install Postgres.
 * Single connection by design, so all access funnels through here.
 */
export function getDb(): Promise<PGlite> {
  if (ready) return ready
  ready = init()
  return ready
}

async function init(): Promise<PGlite> {
  const dir = join(app.getPath('userData'), 'db')
  mkdirSync(dir, { recursive: true })
  log.info('db', 'opening database', { dir })

  const instance = new PGlite(dir, { extensions: { vector } })
  await instance.waitReady
  await migrate(instance)
  db = instance
  log.info('db', 'database ready')
  return instance
}

async function migrate(instance: PGlite): Promise<void> {
  try {
    await instance.exec(`
      CREATE TABLE IF NOT EXISTS schema_migrations (
        id         INTEGER PRIMARY KEY,
        name       TEXT NOT NULL,
        applied_at TIMESTAMPTZ NOT NULL DEFAULT now()
      );
    `)
    const applied = await instance.query<{ id: number }>('SELECT id FROM schema_migrations')
    const done = new Set(applied.rows.map((r) => Number(r.id)))

    for (const m of MIGRATIONS) {
      if (done.has(m.id)) continue
      log.info('db', 'applying migration', { id: m.id, name: m.name })
      // PGlite has no nested-transaction story across exec of DDL batches, so
      // each migration is its own transaction and failures stop the chain.
      await instance.exec('BEGIN')
      try {
        await instance.exec(m.sql)
        await instance.query('INSERT INTO schema_migrations (id, name) VALUES ($1, $2)', [
          m.id,
          m.name
        ])
        await instance.exec('COMMIT')
      } catch (e) {
        await instance.exec('ROLLBACK').catch(() => undefined)
        throw new Error(`migration ${m.id} (${m.name}) failed: ${String(e)}`)
      }
    }
  } catch (e) {
    log.error('db', 'migration failed', { error: String(e) })
    throw DbMigrationError(String(e))
  }
}

export async function query<T = Record<string, unknown>>(
  sql: string,
  params: unknown[] = []
): Promise<T[]> {
  const instance = await getDb()
  const res = await instance.query<T>(sql, params)
  return res.rows
}

export async function one<T = Record<string, unknown>>(
  sql: string,
  params: unknown[] = []
): Promise<T | null> {
  const rows = await query<T>(sql, params)
  return rows[0] ?? null
}

export async function exec(sql: string): Promise<void> {
  const instance = await getDb()
  await instance.exec(sql)
}

export async function closeDb(): Promise<void> {
  if (db) {
    await db.close().catch((e) => log.warn('db', 'close failed', { error: String(e) }))
    db = null
    ready = null
  }
}

export function newId(prefix: string): string {
  return `${prefix}_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 10)}`
}
