import { app } from 'electron'
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { createWriteStream, existsSync, type WriteStream } from 'node:fs'
import { release } from 'node:os'
import { join } from 'node:path'
import { log } from '../log.ts'

/**
 * Drives the ScreenCaptureKit sidecar (native/audiocap/AudioCap.swift).
 *
 * The helper writes raw interleaved f32le at 48 kHz to stdout and one JSON
 * status line per event to stderr. We pipe stdout straight to a .pcm file and
 * let ffmpeg turn it into m4a at finalize -- encoding live would mean a second
 * process in the hot path of a recording for no benefit.
 */

export const SAMPLE_RATE = 48_000
export const CHANNELS = 2
/** What ffmpeg needs to be told, since raw PCM carries no header. */
export const PCM_FORMAT = 'f32le'

/** Darwin 22 is macOS 13 Ventura, where SCStreamConfiguration gained audio. */
const MIN_DARWIN_MAJOR = 22

let resolved: string | null | undefined

/**
 * Packaged, the helper sits beside app.asar via extraResources. In dev it is
 * whatever `npm run build:audiocap` produced under the repo. Resolved once and
 * logged, because "computer audio silently did nothing" is otherwise a very
 * hard thing to diagnose from a user's log file.
 */
function binaryPath(): string | null {
  if (resolved !== undefined) return resolved
  const candidates = [
    join(process.resourcesPath ?? '', 'audiocap'),
    join(app.getAppPath(), 'resources', 'audiocap'),
    // electron-vite serves main from out/, so the app path can point one level
    // in from the repo root depending on how Electron was launched.
    join(app.getAppPath(), '..', 'resources', 'audiocap')
  ]
  resolved = candidates.find((c) => existsSync(c)) ?? null
  log.info('audio', 'sidecar lookup', { resolved, candidates })
  return resolved
}

/** Cheap enough to answer on every settings render; no process is spawned. */
export function sidecarSupported(): boolean {
  if (process.platform !== 'darwin') return false
  if (Number(release().split('.')[0]) < MIN_DARWIN_MAJOR) return false
  return binaryPath() !== null
}

export interface SidecarProbe {
  supported: boolean
  /** Whether Screen Recording has already been granted. Never prompts. */
  granted: boolean
  os: string
}

export async function probeSidecar(): Promise<SidecarProbe | null> {
  if (!sidecarSupported()) return null
  return new Promise((resolve) => {
    const bin = binaryPath()
    if (!bin) return resolve(null)
    const child = spawn(bin, ['--probe'], { windowsHide: true })
    let err = ''
    child.stderr.on('data', (d: Buffer) => (err += d.toString()))
    child.on('error', () => resolve(null))
    child.on('close', () => {
      const line = err.trim().split('\n').find((l) => l.includes('"probe"'))
      if (!line) return resolve(null)
      try {
        const parsed = JSON.parse(line) as { supported?: boolean; granted?: boolean; os?: string }
        resolve({
          supported: Boolean(parsed.supported),
          granted: Boolean(parsed.granted),
          os: parsed.os ?? ''
        })
      } catch {
        resolve(null)
      }
    })
  })
}

interface Capture {
  child: ChildProcessWithoutNullStreams
  sink: WriteStream
  path: string
  bytes: number
  startedAt: number
  firstSampleAt: number
}

const captures = new Map<string, Capture>()

export function captureFormat(): { sampleRate: number; channels: number; format: string } {
  return { sampleRate: SAMPLE_RATE, channels: CHANNELS, format: PCM_FORMAT }
}

/**
 * Resolves once the OS has actually started the stream, so the caller can begin
 * the video recorders knowing audio is already flowing. Rejecting here rather
 * than failing silently matters: a recording that quietly has no computer audio
 * is only discovered after the fact, when the take is gone.
 */
export function startCapture(recordingId: string, outPath: string): Promise<void> {
  if (captures.has(recordingId)) return Promise.resolve()
  const bin = binaryPath()
  if (!bin || !sidecarSupported()) {
    return Promise.reject(new Error('Computer audio capture is not available on this system.'))
  }

  return new Promise((resolve, reject) => {
    const child = spawn(bin, [], { windowsHide: true })
    const sink = createWriteStream(outPath)
    const capture: Capture = {
      child,
      sink,
      path: outPath,
      bytes: 0,
      startedAt: 0,
      firstSampleAt: 0
    }

    let settled = false
    const fail = (message: string): void => {
      if (settled) return
      settled = true
      captures.delete(recordingId)
      sink.end()
      try {
        child.kill('SIGKILL')
      } catch {
        // already gone
      }
      reject(new Error(message))
    }

    child.stdout.on('data', (chunk: Buffer) => {
      // The stream reports itself started before the audio tap delivers
      // anything, and that gap is real time the video is already recording --
      // measured at ~200 ms, which is audible. Recording when the first sample
      // actually landed is what lets finalize push the lane back into sync.
      if (capture.firstSampleAt === 0) capture.firstSampleAt = Date.now()
      capture.bytes += chunk.byteLength
      sink.write(chunk)
    })

    let stderr = ''
    child.stderr.on('data', (d: Buffer) => {
      stderr += d.toString()
      for (const line of stderr.split('\n').slice(0, -1)) {
        if (!line.trim()) continue
        let event: { event?: string; message?: string } = {}
        try {
          event = JSON.parse(line) as typeof event
        } catch {
          continue
        }
        if (event.event === 'started' && !settled) {
          settled = true
          capture.startedAt = Date.now()
          captures.set(recordingId, capture)
          log.info('audio', 'sidecar capture started', { recordingId, outPath })
          resolve()
        } else if (event.event === 'error' || event.event === 'stopped') {
          const denied = (event.message ?? '').includes('declined TCC')
          fail(
            denied
              ? 'macOS has not granted Showoff screen recording, which is also what computer audio goes through. Allow it under Privacy & Security → Screen & System Audio Recording, then reopen Showoff.'
              : `Computer audio capture failed: ${event.message ?? 'unknown error'}`
          )
        }
      }
      stderr = stderr.slice(stderr.lastIndexOf('\n') + 1)
    })

    child.on('error', (e) => fail(`Could not start computer audio capture: ${e.message}`))
    child.on('close', (code) => {
      sink.end()
      if (!settled) fail(`Computer audio capture exited with code ${code}.`)
    })
  })
}

export interface CaptureResult {
  bytes: number
  /**
   * How far behind the picture this audio starts, in milliseconds. The lane is
   * placed at this offset so computer audio lines up with what was on screen.
   */
  offsetMs: number
}

/** Returns what landed on disk; zero bytes if nothing was running. */
export async function stopCapture(recordingId: string): Promise<CaptureResult> {
  const capture = captures.get(recordingId)
  if (!capture) return { bytes: 0, offsetMs: 0 }
  captures.delete(recordingId)

  await new Promise<void>((resolve) => {
    // The helper stops its stream and flushes before exiting, so give it a
    // moment rather than killing it and losing the tail.
    const timer = setTimeout(() => {
      try {
        capture.child.kill('SIGKILL')
      } catch {
        // already gone
      }
      resolve()
    }, 2000)
    capture.child.once('close', () => {
      clearTimeout(timer)
      resolve()
    })
    try {
      capture.child.kill('SIGTERM')
    } catch {
      clearTimeout(timer)
      resolve()
    }
  })

  await new Promise<void>((resolve) => capture.sink.end(() => resolve()))
  const offsetMs =
    capture.firstSampleAt && capture.startedAt
      ? Math.max(0, capture.firstSampleAt - capture.startedAt)
      : 0
  log.info('audio', 'sidecar capture stopped', {
    recordingId,
    bytes: capture.bytes,
    offsetMs,
    ms: capture.startedAt ? Date.now() - capture.startedAt : 0
  })
  return { bytes: capture.bytes, offsetMs }
}

/** Used when a recording is cancelled outright. */
export async function abortCapture(recordingId: string): Promise<void> {
  await stopCapture(recordingId)
}
