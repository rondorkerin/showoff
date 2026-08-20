import { app } from 'electron'
import { createWriteStream, existsSync, mkdirSync, renameSync, statSync, unlinkSync, type WriteStream } from 'node:fs'
import { join } from 'node:path'
import * as repo from './db/repo.ts'
import { muxTracks, posterFrame, probeWithDecode, remuxToMp4 } from './media/render.ts'
import { getSettings } from './settings.ts'
import { EmptyRecordingError, NotFoundError } from '../shared/errors.ts'
import type { TrackKind } from '../shared/types.ts'
import { log } from './log.ts'

interface OpenTrack {
  kind: TrackKind
  partPath: string
  stream: WriteStream
  bytes: number
}

interface Session {
  recordingId: string
  dir: string
  tracks: Map<TrackKind, OpenTrack>
  startedAt: number
}

const sessions = new Map<string, Session>()

function timestampSlug(): string {
  const d = new Date()
  const p = (n: number): string => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}_${p(d.getHours())}-${p(d.getMinutes())}-${p(d.getSeconds())}`
}

export async function startRecording(input: {
  title: string
  projectId: string | null
  kinds: TrackKind[]
}): Promise<{ recordingId: string; dir: string }> {
  const settings = getSettings()
  const slug = timestampSlug()
  const dir = join(settings.storageDir, slug)
  mkdirSync(dir, { recursive: true })

  const rec = await repo.createRecording({
    title: input.title || `Recording ${slug}`,
    dir,
    projectId: input.projectId
  })

  const tracks = new Map<TrackKind, OpenTrack>()
  for (const kind of input.kinds) {
    // .part while writing: an interrupted recording is visibly incomplete
    // rather than a truncated file that looks whole.
    const partPath = join(dir, `${kind}.webm.part`)
    tracks.set(kind, {
      kind,
      partPath,
      stream: createWriteStream(partPath),
      bytes: 0
    })
  }

  sessions.set(rec.id, { recordingId: rec.id, dir, tracks, startedAt: Date.now() })
  log.info('recording', 'started', { recordingId: rec.id, dir, kinds: input.kinds })
  return { recordingId: rec.id, dir }
}

/**
 * Chunks are appended to disk as they arrive. Never buffer a whole recording in
 * memory: a 20 minute screen capture is gigabytes, and a crash mid-session must
 * still leave a playable file behind.
 */
export function writeChunk(recordingId: string, kind: TrackKind, chunk: Uint8Array): void {
  const session = sessions.get(recordingId)
  if (!session) throw NotFoundError('Recording session')
  const track = session.tracks.get(kind)
  if (!track) throw NotFoundError(`Track ${kind}`)
  track.stream.write(Buffer.from(chunk))
  track.bytes += chunk.byteLength
}

async function closeStream(track: OpenTrack): Promise<void> {
  await new Promise<void>((resolve) => track.stream.end(() => resolve()))
}

export async function cancelRecording(recordingId: string): Promise<void> {
  const session = sessions.get(recordingId)
  if (!session) return
  for (const t of session.tracks.values()) {
    await closeStream(t)
    try {
      if (existsSync(t.partPath)) unlinkSync(t.partPath)
    } catch {
      // best effort
    }
  }
  sessions.delete(recordingId)
  await repo.deleteRecording(recordingId)
  log.info('recording', 'cancelled and cleaned up', { recordingId })
}

export interface FinalizeResult {
  recordingId: string
  durationMs: number
  width: number
  height: number
  posterPath: string | null
}

export async function finalizeRecording(
  recordingId: string,
  onProgress: (stage: string, fraction: number) => void
): Promise<FinalizeResult> {
  const session = sessions.get(recordingId)
  if (!session) throw NotFoundError('Recording session')

  onProgress('Closing files', 0.05)
  for (const t of session.tracks.values()) await closeStream(t)

  const written = [...session.tracks.values()]
  const totalBytes = written.reduce((n, t) => n + t.bytes, 0)
  if (totalBytes === 0) {
    sessions.delete(recordingId)
    await cleanupFiles(written.map((t) => t.partPath))
    await repo.deleteRecording(recordingId)
    throw EmptyRecordingError('no chunks were written')
  }

  // Promote .part files now they are complete.
  const finished = new Map<TrackKind, string>()
  for (const t of written) {
    if (t.bytes === 0) {
      try {
        unlinkSync(t.partPath)
      } catch {
        // best effort
      }
      continue
    }
    const finalPath = t.partPath.replace(/\.part$/, '')
    renameSync(t.partPath, finalPath)
    finished.set(t.kind, finalPath)
  }
  sessions.delete(recordingId)

  const screenWebm = finished.get('screen')
  const micWebm = finished.get('mic')
  const camWebm = finished.get('webcam')

  if (!screenWebm && !camWebm) {
    await repo.failRecording(recordingId, 'No video track was captured.')
    throw EmptyRecordingError('no video track was captured')
  }

  onProgress('Converting video', 0.2)
  const videoSource = screenWebm ?? camWebm!
  const masterMp4 = join(session.dir, 'master.mp4')

  let masterInfo
  if (micWebm) {
    // Screen and mic were recorded as separate tracks: mux them so the master
    // is one file, but keep the originals so nothing is destroyed.
    const videoMp4 = join(session.dir, 'screen.mp4')
    await remuxToMp4(videoSource, videoMp4)
    const micMp4 = join(session.dir, 'mic.m4a')
    await remuxToMp4(micWebm, micMp4)
    onProgress('Combining tracks', 0.6)
    masterInfo = await muxTracks(videoMp4, micMp4, masterMp4)
  } else {
    masterInfo = await remuxToMp4(videoSource, masterMp4)
  }

  if (masterInfo.durationMs === 0) {
    const measured = await probeWithDecode(masterMp4)
    masterInfo = measured
  }

  let camMp4: string | null = null
  if (camWebm && screenWebm) {
    onProgress('Converting webcam', 0.8)
    camMp4 = join(session.dir, 'webcam.mp4')
    await remuxToMp4(camWebm, camMp4)
  }

  onProgress('Making thumbnail', 0.9)
  let poster: string | null = null
  try {
    poster = await posterFrame(masterMp4, join(session.dir, 'poster.jpg'), Math.min(1, masterInfo.durationMs / 2000), 640)
  } catch (e) {
    log.warn('recording', 'poster frame failed', { error: String(e) })
  }

  await repo.addTrack(recordingId, 'screen', masterMp4, masterInfo.durationMs)
  if (camMp4) await repo.addTrack(recordingId, 'webcam', camMp4, masterInfo.durationMs)
  if (micWebm) await repo.addTrack(recordingId, 'mic', micWebm, masterInfo.durationMs)

  await repo.finishRecording(recordingId, {
    durationMs: masterInfo.durationMs,
    width: masterInfo.width,
    height: masterInfo.height,
    posterPath: poster
  })

  log.info('recording', 'finalized', {
    recordingId,
    durationMs: masterInfo.durationMs,
    bytes: totalBytes
  })

  return {
    recordingId,
    durationMs: masterInfo.durationMs,
    width: masterInfo.width,
    height: masterInfo.height,
    posterPath: poster
  }
}

/** Attach a voice-over track recorded against an existing recording. */
export async function startVoiceover(recordingId: string): Promise<{ dir: string }> {
  const rec = await repo.getRecording(recordingId)
  if (!rec) throw NotFoundError('Recording')
  const partPath = join(rec.dir, 'voiceover.webm.part')
  sessions.set(recordingId, {
    recordingId,
    dir: rec.dir,
    startedAt: Date.now(),
    tracks: new Map([
      ['voiceover', { kind: 'voiceover', partPath, stream: createWriteStream(partPath), bytes: 0 }]
    ])
  })
  return { dir: rec.dir }
}

export async function finalizeVoiceover(recordingId: string): Promise<{ path: string }> {
  const session = sessions.get(recordingId)
  if (!session) throw NotFoundError('Voiceover session')
  const track = session.tracks.get('voiceover')
  if (!track) throw NotFoundError('Voiceover track')

  await closeStream(track)
  sessions.delete(recordingId)

  if (track.bytes === 0) {
    try {
      unlinkSync(track.partPath)
    } catch {
      // best effort
    }
    throw EmptyRecordingError('voiceover captured no audio')
  }

  const webm = track.partPath.replace(/\.part$/, '')
  renameSync(track.partPath, webm)
  const m4a = join(session.dir, 'voiceover.m4a')
  await remuxToMp4(webm, m4a)
  await repo.addTrack(recordingId, 'voiceover', m4a, null)
  return { path: m4a }
}

/**
 * Throws away an in-progress voice-over and nothing else. Deliberately not
 * cancelRecording: that deletes the recording row and every file with it,
 * which would be a catastrophic thing to do to somebody who just decided they
 * did not like their second take.
 */
export async function cancelVoiceover(recordingId: string): Promise<void> {
  const session = sessions.get(recordingId)
  if (!session) return
  const track = session.tracks.get('voiceover')
  sessions.delete(recordingId)
  if (!track) return
  await closeStream(track)
  try {
    if (existsSync(track.partPath)) unlinkSync(track.partPath)
  } catch {
    // best effort
  }
  log.info('recording', 'voiceover discarded', { recordingId })
}

/**
 * Detaches a saved voice-over. The audio file stays on disk -- same promise as
 * deleting a recording -- but the track row goes, so transcription falls back
 * to the original narration. Without this, saving one voice-over is a one-way
 * door: every later re-transcribe keeps using it and there is no way back.
 */
export async function removeVoiceover(recordingId: string): Promise<void> {
  await repo.deleteTrack(recordingId, 'voiceover')
  log.info('recording', 'voiceover removed', { recordingId })
}

async function cleanupFiles(paths: string[]): Promise<void> {
  for (const p of paths) {
    try {
      if (existsSync(p)) unlinkSync(p)
    } catch {
      // best effort
    }
  }
}

/**
 * On launch, look for .part files from a session that died mid-recording. The
 * bytes are on disk and playable, so offer them back rather than silently
 * leaving orphans in the storage folder.
 */
export function findOrphans(): Array<{ dir: string; path: string; bytes: number }> {
  const settings = getSettings()
  const out: Array<{ dir: string; path: string; bytes: number }> = []
  try {
    const { readdirSync } = require('node:fs') as typeof import('node:fs')
    if (!existsSync(settings.storageDir)) return out
    for (const entry of readdirSync(settings.storageDir, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue
      const dir = join(settings.storageDir, entry.name)
      for (const f of readdirSync(dir)) {
        if (!f.endsWith('.part')) continue
        const p = join(dir, f)
        const bytes = statSync(p).size
        if (bytes > 100_000) out.push({ dir, path: p, bytes })
      }
    }
  } catch (e) {
    log.warn('recording', 'orphan scan failed', { error: String(e) })
  }
  return out
}

export function activeSessionCount(): number {
  return sessions.size
}

export function storageRoot(): string {
  return getSettings().storageDir || join(app.getPath('videos'), 'Showoff')
}
