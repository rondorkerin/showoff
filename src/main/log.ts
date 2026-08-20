import { app } from 'electron'
import { createWriteStream, mkdirSync, type WriteStream } from 'node:fs'
import { join } from 'node:path'

type Level = 'debug' | 'info' | 'warn' | 'error'

let stream: WriteStream | null = null
let logPath = ''

function ensureStream(): WriteStream | null {
  if (stream) return stream
  try {
    const dir = join(app.getPath('userData'), 'logs')
    mkdirSync(dir, { recursive: true })
    logPath = join(dir, 'showoff.jsonl')
    stream = createWriteStream(logPath, { flags: 'a' })
  } catch {
    // Logging must never be the reason the app dies. Fall back to console only.
    stream = null
  }
  return stream
}

function write(level: Level, stage: string, message: string, fields: Record<string, unknown>): void {
  const entry = { ts: new Date().toISOString(), level, stage, message, ...fields }
  const line = JSON.stringify(entry)
  const s = ensureStream()
  if (s) s.write(line + '\n')
  const consoleFn = level === 'error' ? console.error : level === 'warn' ? console.warn : console.log
  consoleFn(`[${stage}] ${message}`, Object.keys(fields).length ? fields : '')
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
