import { app, shell } from 'electron'
import {
  createWriteStream,
  existsSync,
  mkdirSync,
  readdirSync,
  renameSync,
  statSync,
  unlinkSync,
  type WriteStream
} from 'node:fs'
import { join } from 'node:path'
import * as repo from './db/repo.ts'
import { pcmToM4a, posterFrame, probe, probeWithDecode, remuxToMp4 } from './media/render.ts'
import { abortCapture, captureFormat, sidecarSupported, startCapture, stopCapture } from './audio/capture.ts'
import { isBusy } from './jobs/queue.ts'
import { getSettings } from './settings.ts'
import { EmptyRecordingError, NotFoundError } from '../shared/errors.ts'
import {
  DEFAULT_FRAME,
  FULL_FRAME,
  isVideoLane,
  type Interrupted,
  type LaneKind
} from '../shared/types.ts'

export type { Interrupted }
import { log } from './log.ts'

interface OpenTrack {
  kind: LaneKind
  partPath: string
  stream: WriteStream
  bytes: number
}

/**
 * Computer audio on macOS does not arrive as MediaRecorder chunks like every
 * other track -- it comes from the ScreenCaptureKit sidecar as raw PCM, written
 * by the main process rather than pushed from the renderer. It is tracked
 * separately because it has no .webm to remux and no chunks to count.
 */
interface PcmTrack {
  kind: LaneKind
  partPath: string
  bytes: number
  /** How far behind the picture the first sample landed. */
  offsetMs: number
}

interface Session {
  recordingId: string
  dir: string
  tracks: Map<LaneKind, OpenTrack>
  pcm: PcmTrack | null
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
  kinds: LaneKind[]
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

  const tracks = new Map<LaneKind, OpenTrack>()
  let pcm: PcmTrack | null = null
  for (const kind of input.kinds) {
    if (kind === 'system' && sidecarSupported()) {
      pcm = { kind, partPath: join(dir, 'system.pcm.part'), bytes: 0, offsetMs: 0 }
      continue
    }
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

  sessions.set(rec.id, { recordingId: rec.id, dir, tracks, pcm, startedAt: Date.now() })
  log.info('recording', 'started', { recordingId: rec.id, dir, kinds: input.kinds })
  return { recordingId: rec.id, dir }
}

/**
 * Starts the macOS audio sidecar, if this session has one.
 *
 * Deliberately separate from startRecording: the renderer calls it at the
 * instant it starts its own recorders, after any countdown, so the two do not
 * drift apart by however long the user chose to count in.
 */
export async function beginSystemCapture(recordingId: string): Promise<boolean> {
  const session = sessions.get(recordingId)
  if (!session?.pcm) return false
  await startCapture(recordingId, session.pcm.partPath)
  return true
}

/**
 * Chunks are appended to disk as they arrive. Never buffer a whole recording in
 * memory: a 20 minute screen capture is gigabytes, and a crash mid-session must
 * still leave a playable file behind.
 */
export function writeChunk(recordingId: string, kind: LaneKind, chunk: Uint8Array): void {
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
  await abortCapture(recordingId)
  if (session.pcm) await cleanupFiles([session.pcm.partPath])
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
  if (session.pcm) {
    const result = await stopCapture(recordingId)
    session.pcm.bytes = result.bytes
    session.pcm.offsetMs = result.offsetMs
  }
  for (const t of session.tracks.values()) await closeStream(t)

  const written = [...session.tracks.values()]
  const totalBytes = written.reduce((n, t) => n + t.bytes, 0) + (session.pcm?.bytes ?? 0)
  if (totalBytes === 0) {
    sessions.delete(recordingId)
    await cleanupFiles([...written.map((t) => t.partPath), ...(session.pcm ? [session.pcm.partPath] : [])])
    await repo.deleteRecording(recordingId)
    throw EmptyRecordingError('no chunks were written')
  }

  // Promote .part files now they are complete.
  const finished = new Map<LaneKind, string>()
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
  const systemOffsetMs = session.pcm?.offsetMs ?? 0
  let systemPcm: string | null = null
  if (session.pcm && session.pcm.bytes > 0) {
    systemPcm = session.pcm.partPath.replace(/\.part$/, '')
    renameSync(session.pcm.partPath, systemPcm)
  } else if (session.pcm) {
    await cleanupFiles([session.pcm.partPath])
  }
  sessions.delete(recordingId)

  return assembleRecording(
    recordingId,
    session.dir,
    finished,
    systemPcm,
    systemOffsetMs,
    totalBytes,
    onProgress
  )
}

/**
 * Turns whatever finished files are on disk into lanes and marks the recording
 * ready.
 *
 * Split out of finalizeRecording so a recording that was interrupted -- the app
 * quit, the machine slept, something crashed -- can be put back together from
 * the same files by the same code, rather than by a second implementation that
 * drifts from this one.
 */
async function assembleRecording(
  recordingId: string,
  dir: string,
  finished: Map<LaneKind, string>,
  systemPcm: string | null,
  systemOffsetMs: number,
  bytes: number,
  onProgress: (stage: string, fraction: number) => void
): Promise<FinalizeResult> {
  const screenWebm = finished.get('screen')
  const micWebm = finished.get('mic')
  const camWebm = finished.get('webcam')
  const sysWebm = finished.get('system')

  if (!screenWebm && !camWebm) {
    await repo.failRecording(recordingId, 'No video track was captured.')
    throw EmptyRecordingError('no video track was captured')
  }

  // Every source becomes its own file and its own lane. Nothing is baked
  // together here: the mix belongs to the editor, and a finalize step that
  // burned the mic into the screen is exactly what made the old voice-over
  // unusable -- you could add narration but never take the original back out.
  const made: Array<{ kind: LaneKind; path: string; info: Awaited<ReturnType<typeof remuxToMp4>> }> = []

  const convert = async (
    kind: LaneKind,
    webm: string,
    outName: string,
    stage: string,
    at: number
  ): Promise<void> => {
    onProgress(stage, at)
    const out = join(dir, outName)
    let info = await remuxToMp4(webm, out)
    if (info.durationMs === 0) info = await probeWithDecode(out)
    made.push({ kind, path: out, info })
  }

  if (screenWebm) await convert('screen', screenWebm, 'screen.mp4', 'Converting screen', 0.2)
  if (camWebm) await convert('webcam', camWebm, 'webcam.mp4', 'Converting webcam', 0.5)
  if (micWebm) await convert('mic', micWebm, 'mic.m4a', 'Converting microphone', 0.7)
  if (sysWebm) await convert('system', sysWebm, 'system.m4a', 'Converting computer audio', 0.8)
  else if (systemPcm) {
    onProgress('Converting computer audio', 0.8)
    const out = join(dir, 'system.m4a')
    const info = await pcmToM4a(systemPcm, out, captureFormat())
    // Raw f32 is ~11 MB a minute. The .webm intermediates are kept as a safety
    // net because they are the only copy of a compressed stream; this one is
    // pure bulk that the m4a beside it already contains.
    await cleanupFiles([systemPcm])
    made.push({ kind: 'system', path: out, info })
  }

  const primary = made.find((m) => m.kind === 'screen') ?? made.find((m) => m.kind === 'webcam')!
  const durationMs = made.reduce((n, m) => Math.max(n, m.info.durationMs), 0)

  onProgress('Making thumbnail', 0.9)
  let poster: string | null = null
  try {
    poster = await posterFrame(
      primary.path,
      join(dir, 'poster.jpg'),
      Math.min(1, durationMs / 2000),
      640
    )
  } catch (e) {
    log.warn('recording', 'poster frame failed', { error: String(e) })
  }

  for (const m of made) {
    // The webcam sits bottom-right at a quarter width unless the recording is
    // webcam-only, in which case it is the whole picture.
    const isPip = m.kind === 'webcam' && m !== primary
    await repo.addLane({
      recordingId,
      kind: m.kind,
      path: m.path,
      sourceMs: m.info.durationMs || durationMs,
      offsetMs: m.kind === 'system' ? systemOffsetMs : 0,
      z: isPip ? 10 : 0,
      frame: isVideoLane(m.kind) ? (isPip ? DEFAULT_FRAME : FULL_FRAME) : undefined
    })
  }

  await repo.finishRecording(recordingId, {
    durationMs,
    width: primary.info.width,
    height: primary.info.height,
    posterPath: poster
  })

  log.info('recording', 'assembled', {
    recordingId,
    durationMs,
    lanes: made.length,
    bytes
  })

  return {
    recordingId,
    durationMs,
    width: primary.info.width,
    height: primary.info.height,
    posterPath: poster
  }
}


/* --------------------------------------------------- interrupted recordings */

/** Which lane a file left on disk belongs to, from its name. */
function kindFromFile(name: string): LaneKind | null {
  const base = name.replace(/\.part$/, '').replace(/\.(webm|mp4|m4a|pcm)$/, '')
  const stem = base.replace(/-\d+$/, '')
  const kinds: LaneKind[] = ['screen', 'webcam', 'mic', 'system', 'voiceover']
  return kinds.find((k) => k === stem) ?? null
}

/**
 * Recordings the database still believes are in progress.
 *
 * A row is created the moment recording starts and only flipped to 'ready' by
 * finalize, so anything still marked 'recording' with no live session behind it
 * is a take that was cut short. The files are usually fine -- chunks are
 * appended as they arrive, precisely so an interrupted capture leaves something
 * playable -- they just never got assembled.
 */
export async function listInterrupted(): Promise<Interrupted[]> {
  const rows = await repo.listRecordingsByStatus('recording')
  const out: Interrupted[] = []
  for (const rec of rows) {
    // Still capturing, or already being assembled: a take mid-finalize is
    // 'recording' right up until it is 'ready', and offering to recover it
    // would race the job that is doing exactly that.
    if (sessions.has(rec.id) || isBusy(rec.id)) continue
    if (!existsSync(rec.dir)) continue
    let bytes = 0
    const kinds = new Set<LaneKind>()
    for (const f of readdirSync(rec.dir)) {
      if (!/\.(part|webm|pcm)$/.test(f)) continue
      const kind = kindFromFile(f)
      if (!kind) continue
      const size = statSync(join(rec.dir, f)).size
      if (size < 1000) continue
      bytes += size
      kinds.add(kind)
    }

    // A take that never got a byte to disk -- a start that failed before the
    // recorders ran -- is not something to offer back. It is litter, and
    // leaving it in the list means an unfinished banner that can never be
    // resolved by either button.
    if (bytes === 0) {
      log.info('recording', 'reaping a take that never wrote anything', {
        recordingId: rec.id,
        dir: rec.dir
      })
      await trashRecording(rec.id)
      continue
    }

    out.push({
      recordingId: rec.id,
      title: rec.title,
      dir: rec.dir,
      startedAt: rec.created_at,
      bytes,
      kinds: [...kinds]
    })
  }
  return out
}

/**
 * Assembles an interrupted recording from whatever reached disk.
 *
 * Runs the same assembly finalize does, so a recovered take is not a
 * second-class one -- it comes back with the same lanes, the same conversions
 * and the same poster frame.
 */
export async function recoverRecording(
  recordingId: string,
  onProgress: (stage: string, fraction: number) => void
): Promise<FinalizeResult> {
  const rec = await repo.getRecording(recordingId)
  if (!rec) throw NotFoundError('Recording')
  if (sessions.has(recordingId)) throw new Error('That recording is still going.')
  if (!existsSync(rec.dir)) throw EmptyRecordingError('the recording folder is gone')

  onProgress('Looking at what survived', 0.05)
  const finished = new Map<LaneKind, string>()
  let systemPcm: string | null = null
  let bytes = 0

  for (const f of readdirSync(rec.dir).sort()) {
    const kind = kindFromFile(f)
    if (!kind) continue
    const full = join(rec.dir, f)
    const size = statSync(full).size
    if (size < 1000) continue

    // Promote anything still marked .part: it is as complete as it is ever
    // going to get, and leaving the suffix on would hide it from every reader.
    let path = full
    if (f.endsWith('.part')) {
      path = full.replace(/\.part$/, '')
      renameSync(full, path)
    }
    bytes += size
    if (path.endsWith('.pcm')) systemPcm = path
    else if (path.endsWith('.webm') && !finished.has(kind)) finished.set(kind, path)
  }

  if (finished.size === 0 && !systemPcm) {
    await repo.failRecording(recordingId, 'Nothing usable was written before it stopped.')
    throw EmptyRecordingError('nothing usable was written')
  }

  log.info('recording', 'recovering', {
    recordingId,
    kinds: [...finished.keys()],
    hasSystemPcm: Boolean(systemPcm),
    bytes
  })

  // Offset is unknowable after the fact -- the process that measured it is
  // gone -- and 11 ms of drift is not worth refusing to recover a take over.
  return assembleRecording(recordingId, rec.dir, finished, systemPcm, 0, bytes, onProgress)
}

/**
 * Removes a recording and sends its folder to the Trash.
 *
 * Trash rather than unlink, deliberately. Deleting from the library used to
 * leave every byte on disk, which meant "delete" never actually freed anything
 * and the storage folder grew forever; unlinking instead would make a misclick
 * unrecoverable. The Trash is the only option that is both honest about
 * removing the files and forgiving about it.
 */
export async function trashRecording(recordingId: string): Promise<void> {
  const rec = await repo.getRecording(recordingId)
  if (!rec) return
  if (sessions.has(recordingId)) throw new Error('That recording is still going.')
  if (isBusy(recordingId)) throw new Error('That recording is still being processed.')
  await repo.deleteRecording(recordingId)
  try {
    if (existsSync(rec.dir)) await shell.trashItem(rec.dir)
  } catch (e) {
    log.warn('recording', 'could not trash recording folder', { error: String(e) })
  }
  log.info('recording', 'moved to trash', { recordingId, dir: rec.dir })
}

/** Gives up on an interrupted recording, sending its files to the Trash. */
export async function discardInterrupted(recordingId: string): Promise<void> {
  await trashRecording(recordingId)
}

/* ------------------------------------------------------- adding a source */

/**
 * Record another source into a recording that already exists.
 *
 * A session is not one capture any more. You start with a screen share, and
 * later you want the same project to also carry your face, or a second window,
 * or the audio from the call -- each of those is another lane, recorded now and
 * placed on the timeline afterwards, not a separate recording you then have to
 * reconcile by hand.
 */
export async function startAddSource(
  recordingId: string,
  kinds: LaneKind[]
): Promise<{ dir: string }> {
  const rec = await repo.getRecording(recordingId)
  if (!rec) throw NotFoundError('Recording')
  if (sessions.has(recordingId)) throw new Error('Something is already recording into this project.')

  const existing = await repo.listLanes(recordingId)
  const tracks = new Map<LaneKind, OpenTrack>()
  let pcm: PcmTrack | null = null
  for (const kind of kinds) {
    const n = existing.filter((l) => l.kind === kind).length + 1
    if (kind === 'system' && sidecarSupported()) {
      pcm = { kind, partPath: join(rec.dir, `system-${n}.pcm.part`), bytes: 0, offsetMs: 0 }
      continue
    }
    const partPath = join(rec.dir, `${kind}-${n}.webm.part`)
    tracks.set(kind, { kind, partPath, stream: createWriteStream(partPath), bytes: 0 })
  }
  sessions.set(recordingId, { recordingId, dir: rec.dir, tracks, pcm, startedAt: Date.now() })
  log.info('recording', 'adding sources', { recordingId, kinds })
  return { dir: rec.dir }
}

export async function finalizeAddSource(
  recordingId: string,
  onProgress: (stage: string, fraction: number) => void
): Promise<{ added: number }> {
  const session = sessions.get(recordingId)
  if (!session) throw NotFoundError('Recording session')

  onProgress('Closing files', 0.05)
  if (session.pcm) {
    const result = await stopCapture(recordingId)
    session.pcm.bytes = result.bytes
    session.pcm.offsetMs = result.offsetMs
  }
  for (const t of session.tracks.values()) await closeStream(t)
  const written = [...session.tracks.values()].filter((t) => t.bytes > 0)
  const addedPcm = session.pcm && session.pcm.bytes > 0 ? session.pcm : null
  if (session.pcm && !addedPcm) await cleanupFiles([session.pcm.partPath])
  sessions.delete(recordingId)

  if (written.length === 0 && !addedPcm) {
    await cleanupFiles([...session.tracks.values()].map((t) => t.partPath))
    throw EmptyRecordingError('the added source captured nothing')
  }

  const lanes = await repo.listLanes(recordingId)
  let z = lanes.reduce((n, l) => Math.max(n, l.z), 0)
  let added = 0

  for (const [i, t] of written.entries()) {
    const webm = t.partPath.replace(/\.part$/, '')
    renameSync(t.partPath, webm)
    const ext = isVideoLane(t.kind) ? '.mp4' : '.m4a'
    const out = webm.replace(/\.webm$/, ext)
    onProgress(`Converting ${t.kind}`, 0.1 + (i / written.length) * 0.85)
    let info = await remuxToMp4(webm, out)
    if (info.durationMs === 0) info = await probeWithDecode(out)

    // New video arrives on top and in the corner: it is an addition to a shot
    // that already works, so it must not cover it up.
    const video = isVideoLane(t.kind)
    if (video) z += 10
    await repo.addLane({
      recordingId,
      kind: t.kind,
      path: out,
      sourceMs: info.durationMs,
      z: video ? z : 0,
      frame: video ? DEFAULT_FRAME : undefined
    })
    added++
  }

  if (addedPcm) {
    const pcmPath = addedPcm.partPath.replace(/\.part$/, '')
    renameSync(addedPcm.partPath, pcmPath)
    onProgress('Converting computer audio', 0.95)
    const out = pcmPath.replace(/\.pcm$/, '.m4a')
    const info = await pcmToM4a(pcmPath, out, captureFormat())
    await cleanupFiles([pcmPath])
    await repo.addLane({
      recordingId,
      kind: 'system',
      path: out,
      sourceMs: info.durationMs,
      offsetMs: addedPcm.offsetMs,
      z: 0
    })
    added++
  }

  log.info('recording', 'sources added', { recordingId, added })
  return { added }
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
    pcm: null,
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
  const info = await probe(m4a).catch(() => null)
  await repo.addLane({ recordingId, kind: 'voiceover', path: m4a, sourceMs: info?.durationMs ?? null })
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
  const lane = await repo.firstLane(recordingId, 'voiceover')
  if (lane) await repo.deleteLane(lane.id)
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
