import { spawn } from 'node:child_process'
import { createWriteStream, existsSync, mkdirSync, readFileSync, renameSync, statSync, unlinkSync } from 'node:fs'
import { basename, dirname, join } from 'node:path'
import { Readable } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import {
  NoSpeechError,
  TranscriptionFailedError,
  TranscriptionUnavailableError
} from '../../shared/errors.ts'
import type { ProviderStatus } from '../../shared/types.ts'
import { log } from '../log.ts'
import {
  findWhisperBin,
  installWhisper,
  whisperInstallRoute,
  whisperSpawnEnv
} from './install.ts'

export interface Segment {
  startMs: number
  endMs: number
  text: string
}

export interface TranscriptResult {
  provider: string
  language: string
  text: string
  segments: Segment[]
}

export interface SttConfig {
  whisperBin: string
  whisperModel: string
  /** Where auto-downloaded models are cached. */
  modelDir: string
  openaiApiKey: string
  groqApiKey: string
  onProgress?: (fraction: number, note: string) => void
}

export interface SttProvider {
  id: string
  label: string
  available(cfg: SttConfig): Promise<{ ok: boolean; detail: string }>
  transcribe(wavPath: string, cfg: SttConfig): Promise<TranscriptResult>
}

const WHISPER_MODEL_URL =
  'https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-base.en.bin'
const WHISPER_MODEL_NAME = 'ggml-base.en.bin'

export function resolveWhisperModel(cfg: SttConfig): string | null {
  if (cfg.whisperModel && existsSync(cfg.whisperModel)) return cfg.whisperModel
  const cached = join(cfg.modelDir, WHISPER_MODEL_NAME)
  if (existsSync(cached)) return cached
  return null
}

/**
 * Fetches the Whisper model on first use rather than bloating the installer by
 * 150MB. Downloads to a .part file and renames on success, so an interrupted
 * download can never be mistaken for a complete model.
 */
export async function downloadWhisperModel(
  cfg: SttConfig,
  onProgress?: (fraction: number) => void
): Promise<string> {
  mkdirSync(cfg.modelDir, { recursive: true })
  const target = join(cfg.modelDir, WHISPER_MODEL_NAME)
  if (existsSync(target) && statSync(target).size > 1_000_000) return target

  const partial = `${target}.part`
  log.info('stt', 'downloading whisper model', { url: WHISPER_MODEL_URL })

  const res = await fetch(WHISPER_MODEL_URL)
  if (!res.ok || !res.body) {
    throw TranscriptionFailedError(`model download failed with HTTP ${res.status}`)
  }
  const total = Number(res.headers.get('content-length') ?? 0)
  let received = 0
  // Throttled to whole percent: the raw stream fires thousands of times and
  // each one would cross the IPC boundary and re-render the UI.
  let lastPct = -1

  const body = Readable.fromWeb(res.body as Parameters<typeof Readable.fromWeb>[0])
  body.on('data', (chunk: Buffer) => {
    received += chunk.length
    if (total <= 0 || !onProgress) return
    const pct = Math.floor((received / total) * 100)
    if (pct !== lastPct) {
      lastPct = pct
      onProgress(received / total)
    }
  })

  try {
    await pipeline(body, createWriteStream(partial))
    renameSync(partial, target)
  } catch (e) {
    try {
      if (existsSync(partial)) unlinkSync(partial)
    } catch {
      // best effort
    }
    throw TranscriptionFailedError(`model download failed: ${String(e)}`)
  }
  log.info('stt', 'whisper model ready', { path: target, bytes: statSync(target).size })
  return target
}

interface WhisperJson {
  result?: { language?: string }
  transcription?: Array<{
    offsets?: { from?: number; to?: number }
    timestamps?: { from?: string; to?: string }
    text?: string
  }>
}

export const whisperCppProvider: SttProvider = {
  id: 'whisper-cpp',
  label: 'Whisper (local, whisper.cpp)',
  async available(cfg) {
    const bin = findWhisperBin(cfg.whisperBin, cfg.modelDir)
    const model = resolveWhisperModel(cfg)
    if (!bin) {
      // A binary we can fetch unattended is as good as one already here, so
      // long as we say that is what will happen.
      if (whisperInstallRoute() === 'download') {
        return { ok: true, detail: 'whisper.cpp downloads on first use (~8MB)' }
      }
      return {
        ok: false,
        detail:
          whisperInstallRoute() === 'homebrew'
            ? 'not installed yet - Settings can install it with Homebrew'
            : 'whisper-cli not found, and there is no prebuilt build for this platform'
      }
    }
    return {
      ok: true,
      detail: model ? `${basename(bin)} with ${basename(model)}` : `${basename(bin)}, model downloads on first use`
    }
  },
  async transcribe(wavPath, cfg) {
    let bin = findWhisperBin(cfg.whisperBin, cfg.modelDir)
    if (!bin) {
      // Same bargain as the model: fetch it once, at the moment it is needed,
      // rather than putting it in the installer.
      cfg.onProgress?.(0.01, 'Getting Whisper (one time, ~8MB)')
      bin = await installWhisper(cfg.whisperBin, cfg.modelDir, (f, note) =>
        cfg.onProgress?.(0.01 + f * 0.01, note)
      )
    }

    let model = resolveWhisperModel(cfg)
    if (!model) {
      cfg.onProgress?.(0.02, 'Downloading the Whisper model (one time, ~150MB)')
      model = await downloadWhisperModel(cfg, (f) =>
        cfg.onProgress?.(0.02 + f * 0.28, 'Downloading the Whisper model')
      )
    }

    const outBase = join(dirname(wavPath), basename(wavPath, '.wav') + '-whisper')
    const args = [
      '-m', model,
      '-f', wavPath,
      '-oj',
      '-of', outBase,
      '-np',
      '-pp',
      '-l', 'en',
      '-t', String(Math.max(2, Math.min(8, (await import('node:os')).cpus().length - 2)))
    ]

    await new Promise<void>((resolve, reject) => {
      const child = spawn(bin, args, { windowsHide: true, env: whisperSpawnEnv(bin) })
      let stderr = ''
      child.stderr.on('data', (d: Buffer) => {
        const s = d.toString()
        stderr += s
        if (stderr.length > 20000) stderr = stderr.slice(-12000)
        const m = s.match(/progress\s*=\s*(\d+)%/)
        if (m) cfg.onProgress?.(0.3 + (Number(m[1]) / 100) * 0.7, 'Transcribing')
      })
      child.on('error', (e) => reject(TranscriptionFailedError(`whisper-cli failed to start: ${e.message}`)))
      child.on('close', (code) =>
        code === 0 ? resolve() : reject(TranscriptionFailedError(`whisper-cli exited ${code}: ${stderr.slice(-1500)}`))
      )
    })

    const jsonPath = `${outBase}.json`
    if (!existsSync(jsonPath)) {
      throw TranscriptionFailedError(`whisper-cli produced no JSON at ${jsonPath}`)
    }
    const parsed = JSON.parse(readFileSync(jsonPath, 'utf8')) as WhisperJson
    const segments: Segment[] = (parsed.transcription ?? [])
      .map((t) => ({
        // whisper.cpp offsets are already milliseconds.
        startMs: Math.round(Number(t.offsets?.from ?? 0)),
        endMs: Math.round(Number(t.offsets?.to ?? 0)),
        text: (t.text ?? '').trim()
      }))
      .filter((s) => s.text.length > 0 && s.endMs > s.startMs)

    if (segments.length === 0) throw NoSpeechError('whisper returned no segments')

    return {
      provider: 'whisper-cpp',
      language: parsed.result?.language ?? 'en',
      text: segments.map((s) => s.text).join(' '),
      segments
    }
  }
}

/** OpenAI-compatible /audio/transcriptions with verbose_json for timestamps. */
async function cloudTranscribe(
  wavPath: string,
  baseUrl: string,
  apiKey: string,
  model: string,
  providerId: string
): Promise<TranscriptResult> {
  const bytes = statSync(wavPath).size
  // Both OpenAI and Groq cap uploads at 25MB. 16kHz mono wav is ~32KB/s, so
  // that is roughly 13 minutes — long enough to matter, so say so clearly.
  if (bytes > 24 * 1024 * 1024) {
    throw TranscriptionFailedError(
      `this recording's audio is ${(bytes / 1024 / 1024).toFixed(0)}MB, over the ${providerId} 25MB upload limit. Use local Whisper for recordings this long.`
    )
  }

  const form = new FormData()
  form.append('file', new Blob([readFileSync(wavPath)], { type: 'audio/wav' }), basename(wavPath))
  form.append('model', model)
  form.append('response_format', 'verbose_json')

  const res = await fetch(`${baseUrl}/audio/transcriptions`, {
    method: 'POST',
    headers: { authorization: `Bearer ${apiKey}` },
    body: form
  })
  const text = await res.text()
  if (!res.ok) throw TranscriptionFailedError(`${providerId} returned ${res.status}: ${text.slice(0, 800)}`)

  let parsed: { language?: string; text?: string; segments?: Array<{ start: number; end: number; text: string }> }
  try {
    parsed = JSON.parse(text)
  } catch {
    throw TranscriptionFailedError(`${providerId} returned non-JSON: ${text.slice(0, 400)}`)
  }

  const segments: Segment[] = (parsed.segments ?? [])
    .map((s) => ({
      startMs: Math.round(s.start * 1000),
      endMs: Math.round(s.end * 1000),
      text: (s.text ?? '').trim()
    }))
    .filter((s) => s.text.length > 0 && s.endMs > s.startMs)

  if (segments.length === 0) throw NoSpeechError(`${providerId} returned no segments`)

  return {
    provider: providerId,
    language: parsed.language ?? 'en',
    text: parsed.text ?? segments.map((s) => s.text).join(' '),
    segments
  }
}

export const groqProvider: SttProvider = {
  id: 'groq',
  label: 'Groq Whisper (cloud, fast)',
  async available(cfg) {
    return cfg.groqApiKey ? { ok: true, detail: 'API key set' } : { ok: false, detail: 'no GROQ_API_KEY' }
  },
  transcribe: (wav, cfg) =>
    cloudTranscribe(wav, 'https://api.groq.com/openai/v1', cfg.groqApiKey, 'whisper-large-v3-turbo', 'groq')
}

export const openaiSttProvider: SttProvider = {
  id: 'openai',
  label: 'OpenAI Whisper (cloud)',
  async available(cfg) {
    return cfg.openaiApiKey ? { ok: true, detail: 'API key set' } : { ok: false, detail: 'no OPENAI_API_KEY' }
  },
  transcribe: (wav, cfg) =>
    cloudTranscribe(wav, 'https://api.openai.com/v1', cfg.openaiApiKey, 'whisper-1', 'openai')
}

export const STT_PROVIDERS: SttProvider[] = [whisperCppProvider, groqProvider, openaiSttProvider]

export async function sttStatuses(cfg: SttConfig): Promise<ProviderStatus[]> {
  return Promise.all(
    STT_PROVIDERS.map(async (p) => {
      const r = await p.available(cfg).catch((e) => ({ ok: false, detail: String(e) }))
      return { id: p.id, label: p.label, available: r.ok, detail: r.detail }
    })
  )
}

export async function transcribe(
  wavPath: string,
  preferred: string,
  cfg: SttConfig
): Promise<TranscriptResult> {
  let provider: SttProvider | undefined

  if (preferred && preferred !== 'auto') {
    provider = STT_PROVIDERS.find((p) => p.id === preferred)
    if (!provider) throw TranscriptionUnavailableError(`unknown provider "${preferred}"`)
    const r = await provider.available(cfg)
    if (!r.ok) throw TranscriptionUnavailableError(`${provider.label} is not usable: ${r.detail}`)
  } else {
    for (const p of STT_PROVIDERS) {
      const r = await p.available(cfg).catch(() => ({ ok: false, detail: '' }))
      if (r.ok) {
        provider = p
        break
      }
    }
    if (!provider) throw TranscriptionUnavailableError('no transcription provider is configured')
  }

  const started = Date.now()
  log.info('stt', 'transcribing', { provider: provider.id, wav: wavPath })
  const result = await provider.transcribe(wavPath, cfg)
  log.info('stt', 'transcription done', {
    provider: provider.id,
    ms: Date.now() - started,
    segments: result.segments.length
  })
  return result
}
