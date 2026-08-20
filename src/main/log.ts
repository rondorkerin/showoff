import { createWriteStream, mkdirSync, type WriteStream } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

type Level = 'debug' | 'info' | 'warn' | 'error'

let stream: WriteStream | null = null
let attempted = false
let logPath = ''

/**
 * Resolved lazily and defensively: the media and provider modules are plain
 * Node so they can be tested outside Electron, and logging must not be the
 * thing that makes them un-importable.
 */
function logDir(): string {
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const electron = require('electron') as { app?: { getPath(n: string): string } }
    if (electron?.app?.getPath) return join(electron.app.getPath('userData'), 'logs')
  } catch {
    // not running inside Electron
  }
  return join(tmpdir(), 'showoff-logs')
}

function ensureStream(): WriteStream | null {
  if (attempted) return stream
  attempted = true
  try {
    const dir = logDir()
    mkdirSync(dir, { recursive: true })
    logPath = join(dir, 'showoff.jsonl')
    stream = createWriteStream(logPath, { flags: 'a' })
  } catch {
    stream = null
  }
  return stream
}

const QUIET = process.env.SHOWOFF_QUIET === '1'

function write(level: Level, stage: string, message: string, fields: Record<string, unknown>): void {
  const entry = { ts: new Date().toISOString(), level, stage, message, ...fields }
  const s = ensureStream()
  if (s) s.write(JSON.stringify(entry) + '\n')
  if (QUIET && level !== 'error') return
  const fn = level === 'error' ? console.error : level === 'warn' ? console.warn : console.log
  fn(`[${stage}] ${message}`, Object.keys(fields).length ? fields : '')
}

export const log = {
  debug: (stage: string, message: string, fields: Record<string, unknown> = {}) =>
    write('debug', stage, message, fields),
  info: (stage: string, message: string, fields: Record<string, unknown> = {}) =>
    write('info', stage, message, fields),
  warn: (stage: string, message: string, fields: Record<string, unknown> = {}) =>
    write('warn', stage, message, fields),
  error: (stage: string, message: string, fields: Record<string, unknown> = {}) =>
    write('error', stage, message, fields),
  path: () => logPath
}
