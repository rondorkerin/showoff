import { app } from 'electron'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { AppSettings } from '../shared/types.ts'
import { PLATFORM_IDS } from '../shared/platforms.ts'
import { DEFAULT_CLIP_PLAN_PROMPT, DEFAULT_NOTES_PROMPT, DEFAULT_QUESTIONS_PROMPT } from './prompts.ts'
import { log } from './log.ts'

let cached: AppSettings | null = null

function settingsPath(): string {
  return join(app.getPath('userData'), 'settings.json')
}

export function defaultStorageDir(): string {
  // Videos, not userData: people need to find their own footage in Finder, and
  // uninstallers wipe app-data directories.
  let base: string
  try {
    base = app.getPath('videos')
  } catch {
    base = app.getPath('home')
  }
  return join(base, 'Showoff')
}

export function defaultSettings(): AppSettings {
  return {
    storageDir: defaultStorageDir(),
    llmProvider: 'auto',
    llmModel: '',
    sttProvider: 'auto',
    anthropicApiKey: '',
    openaiApiKey: '',
    groqApiKey: '',
    ollamaBaseUrl: 'http://127.0.0.1:11434',
    ollamaModel: '',
    customBaseUrl: '',
    customApiKey: '',
    customModel: '',
    whisperBin: '',
    whisperModel: '',
    burnCaptions: true,
    webcamPip: true,
    trimSilence: false,
    maxClips: 6,
    platforms: [...PLATFORM_IDS],
    promptClipPlan: DEFAULT_CLIP_PLAN_PROMPT,
    promptQuestions: DEFAULT_QUESTIONS_PROMPT,
    promptNotes: DEFAULT_NOTES_PROMPT
  }
}

export function getSettings(): AppSettings {
  if (cached) return cached
  const defaults = defaultSettings()
  try {
    const p = settingsPath()
    if (existsSync(p)) {
      const raw = JSON.parse(readFileSync(p, 'utf8')) as Partial<AppSettings>
      cached = { ...defaults, ...raw }
      // A settings file from an older build can carry a platform id we removed.
      cached.platforms = (cached.platforms ?? []).filter((p2) =>
        (PLATFORM_IDS as string[]).includes(p2)
      )
      if (cached.platforms.length === 0) cached.platforms = [...PLATFORM_IDS]
    } else {
      cached = defaults
    }
  } catch (e) {
    log.warn('settings', 'settings.json unreadable, using defaults', { error: String(e) })
    cached = defaults
  }
  ensureStorageDir(cached.storageDir)
  return cached
}

export function saveSettings(patch: Partial<AppSettings>): AppSettings {
  const next = { ...getSettings(), ...patch }
  cached = next
  try {
    mkdirSync(app.getPath('userData'), { recursive: true })
    writeFileSync(settingsPath(), JSON.stringify(next, null, 2), 'utf8')
  } catch (e) {
    log.error('settings', 'failed to persist settings', { error: String(e) })
    throw e
  }
  ensureStorageDir(next.storageDir)
  return next
}

export function ensureStorageDir(dir: string): void {
  try {
    mkdirSync(dir, { recursive: true })
  } catch (e) {
    log.error('settings', 'could not create storage dir', { dir, error: String(e) })
  }
}

/** Env vars win over stored keys so a developer can run with a shell key set. */
export function resolveKey(kind: 'anthropic' | 'openai' | 'groq'): string {
  const s = getSettings()
  if (kind === 'anthropic') return process.env.ANTHROPIC_API_KEY || s.anthropicApiKey || ''
  if (kind === 'openai') return process.env.OPENAI_API_KEY || s.openaiApiKey || ''
  return process.env.GROQ_API_KEY || s.groqApiKey || ''
}
