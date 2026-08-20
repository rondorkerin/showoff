import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import ffmpegStatic from 'ffmpeg-static'
import ffprobeStatic from 'ffprobe-static'
import { FfmpegError } from '../../shared/errors.ts'
import { log } from '../log.ts'

/**
 * The bundled binaries live inside app.asar at build time; electron-builder
 * unpacks them to app.asar.unpacked, so the runtime path needs rewriting.
 * Falls back to whatever is on PATH if the bundle is somehow missing.
 */
function resolveBinary(bundled: string | null, fallback: string): string {
  if (!bundled) return fallback
  const unpacked = bundled.replace('app.asar', 'app.asar.unpacked')
  if (existsSync(unpacked)) return unpacked
  if (existsSync(bundled)) return bundled
  return fallback
}

let ffmpegPath: string | null = null
let ffprobePath: string | null = null

export function getFfmpegPath(): string {
  if (!ffmpegPath) {
    ffmpegPath = resolveBinary(ffmpegStatic as unknown as string | null, 'ffmpeg')
  }
  return ffmpegPath
}

export function getFfprobePath(): string {
  if (!ffprobePath) {
    const p = (ffprobeStatic as unknown as { path?: string })?.path ?? null
    ffprobePath = resolveBinary(p, 'ffprobe')
  }
  return ffprobePath
}

export interface RunOptions {
  /** Called with 0..1 when a total duration is known. */
  onProgress?: (fraction: number) => void
  /** Total duration in seconds, used to derive progress from ffmpeg's -progress. */
  totalSeconds?: number
  label?: string
}

/**
 * Runs ffmpeg and rejects with a named FfmpegError carrying the stderr tail.
 * Never resolves on a non-zero exit — a silent ffmpeg failure would produce a
 * zero-byte clip that looks like success.
 */
export function runFfmpeg(args: string[], opts: RunOptions = {}): Promise<void> {
  const bin = getFfmpegPath()
  log.debug('ffmpeg', opts.label ?? 'run', { argv: args.join(' ') })

  return new Promise((resolve, reject) => {
    const child = spawn(bin, ['-hide_banner', '-nostdin', '-y', ...args], {
      windowsHide: true
    })
    let stderr = ''

    child.stderr.on('data', (d: Buffer) => {
      const chunk = d.toString()
      stderr += chunk
      // Keep only the tail; a long render can emit megabytes of progress lines.
      if (stderr.length > 24000) stderr = stderr.slice(-16000)

      if (opts.onProgress && opts.totalSeconds && opts.totalSeconds > 0) {
        const m = chunk.match(/time=(\d+):(\d+):(\d+\.?\d*)/)
        if (m) {
          const secs = Number(m[1]) * 3600 + Number(m[2]) * 60 + Number(m[3])
          opts.onProgress(Math.max(0, Math.min(1, secs / opts.totalSeconds)))
        }
      }
    })

    child.on('error', (e) => {
      reject(FfmpegError(`could not start ffmpeg at ${bin}: ${e.message}`))
    })

    child.on('close', (code) => {
      if (code === 0) return resolve()
      reject(FfmpegError(`ffmpeg exited ${code}\n\nargs: ${args.join(' ')}\n\n${stderr.slice(-4000)}`))
    })
  })
}

export function runFfprobe(args: string[]): Promise<string> {
  const bin = getFfprobePath()
  return new Promise((resolve, reject) => {
    const child = spawn(bin, args, { windowsHide: true })
    let stdout = ''
    let stderr = ''
    child.stdout.on('data', (d: Buffer) => (stdout += d.toString()))
    child.stderr.on('data', (d: Buffer) => (stderr += d.toString()))
    child.on('error', (e) => reject(FfmpegError(`could not start ffprobe at ${bin}: ${e.message}`)))
    child.on('close', (code) => {
      if (code === 0) return resolve(stdout)
      reject(FfmpegError(`ffprobe exited ${code}: ${stderr.slice(-2000)}`))
    })
  })
}

export interface MediaInfo {
  durationMs: number
  width: number
  height: number
  fps: number
  hasAudio: boolean
  hasVideo: boolean
}

export async function probe(path: string): Promise<MediaInfo> {
  const out = await runFfprobe([
    '-v',
    'error',
    '-print_format',
    'json',
    '-show_format',
    '-show_streams',
    path
  ])

  let parsed: {
    format?: { duration?: string }
    streams?: Array<{
      codec_type?: string
      width?: number
      height?: number
      avg_frame_rate?: string
      duration?: string
    }>
  }
  try {
    parsed = JSON.parse(out)
  } catch (e) {
    throw FfmpegError(`ffprobe returned unparseable JSON for ${path}: ${String(e)}`)
  }

  const streams = parsed.streams ?? []
  const video = streams.find((s) => s.codec_type === 'video')
  const audio = streams.find((s) => s.codec_type === 'audio')

  let durationSec = Number(parsed.format?.duration ?? 0)
  if (!Number.isFinite(durationSec) || durationSec <= 0) {
    // WebM straight off MediaRecorder often has no container duration.
    durationSec = Number(video?.duration ?? audio?.duration ?? 0)
  }

  let fps = 30
  if (video?.avg_frame_rate && video.avg_frame_rate !== '0/0') {
    const [n, d] = video.avg_frame_rate.split('/').map(Number)
    if (d > 0 && Number.isFinite(n / d)) fps = n / d
  }

  return {
    durationMs: Math.round((Number.isFinite(durationSec) ? durationSec : 0) * 1000),
    width: video?.width ?? 0,
    height: video?.height ?? 0,
    fps,
    hasAudio: Boolean(audio),
    hasVideo: Boolean(video)
  }
}

/** ffprobe cannot always read a MediaRecorder webm's duration; decoding can. */
export async function probeWithDecode(path: string): Promise<MediaInfo> {
  const info = await probe(path)
  if (info.durationMs > 0) return info

  log.warn('ffmpeg', 'no container duration, decoding to measure', { path })
  const out = await runFfprobe([
    '-v',
    'error',
    '-count_packets',
    '-select_streams',
    'v:0',
    '-show_entries',
    'stream=nb_read_packets,duration',
    '-print_format',
    'json',
    path
  ])
  try {
    const parsed = JSON.parse(out) as {
      streams?: Array<{ nb_read_packets?: string; duration?: string }>
    }
    const s = parsed.streams?.[0]
    const dur = Number(s?.duration ?? 0)
    if (dur > 0) return { ...info, durationMs: Math.round(dur * 1000) }
    const packets = Number(s?.nb_read_packets ?? 0)
    if (packets > 0 && info.fps > 0) {
      return { ...info, durationMs: Math.round((packets / info.fps) * 1000) }
    }
  } catch {
    // fall through to the original zero, callers treat that as "too short"
  }
  return info
}
