import { BrowserWindow } from 'electron'
import * as repo from '../db/repo.ts'
import { serializeError } from '../../shared/errors.ts'
import { log } from '../log.ts'

export interface JobHandle {
  id: string
  kind: string
  recordingId: string | null
}

type Task = (onProgress: (stage: string, fraction: number) => void) => Promise<unknown>

interface Queued {
  handle: JobHandle
  task: Task
}

const queue: Queued[] = []
let running = false

function broadcast(channel: string, payload: unknown): void {
  for (const w of BrowserWindow.getAllWindows()) {
    if (!w.isDestroyed()) w.webContents.send(channel, payload)
  }
}

/**
 * Jobs live in main, not in a React component. Navigating away from a screen or
 * closing a detail view never cancels work that is already running, and the
 * `jobs` table means a crashed app can still say what was in flight.
 *
 * Serial by design: ffmpeg and whisper both saturate the machine, so running
 * two at once makes both slower and the UI worse.
 */
export async function enqueue(
  kind: string,
  recordingId: string | null,
  task: Task
): Promise<JobHandle> {
  const job = await repo.createJob(recordingId, kind)
  const handle: JobHandle = { id: job.id, kind, recordingId }
  queue.push({ handle, task })
  broadcast('job:queued', handle)
  void drain()
  return handle
}

async function drain(): Promise<void> {
  if (running) return
  running = true
  try {
    while (queue.length > 0) {
      const next = queue.shift()!
      await run(next)
    }
  } finally {
    running = false
  }
}

async function run({ handle, task }: Queued): Promise<void> {
  const started = Date.now()
  await repo.updateJob(handle.id, { status: 'running', stage: 'Starting', progress: 0 })
  broadcast('job:update', { ...handle, status: 'running', stage: 'Starting', progress: 0 })

  // Progress is throttled: ffmpeg and whisper emit hundreds of updates a second
  // and every one crossing IPC would stall the renderer.
  let lastEmit = 0
  let lastStage = ''
  const onProgress = (stage: string, fraction: number): void => {
    const now = Date.now()
    if (now - lastEmit < 200 && stage === lastStage) return
    lastEmit = now
    lastStage = stage
    const progress = Math.max(0, Math.min(1, fraction))
    broadcast('job:update', { ...handle, status: 'running', stage, progress })
    void repo.updateJob(handle.id, { stage, progress })
  }

  try {
    const result = await task(onProgress)
    await repo.updateJob(handle.id, { status: 'done', stage: 'Done', progress: 1, error: null })
    broadcast('job:done', { ...handle, status: 'done', result })
    log.info('jobs', 'job finished', { kind: handle.kind, ms: Date.now() - started })
  } catch (e) {
    const err = serializeError(e)
    await repo.updateJob(handle.id, { status: 'failed', error: `${err.code}: ${err.message}` })
    broadcast('job:failed', { ...handle, status: 'failed', error: err })
    log.error('jobs', 'job failed', {
      kind: handle.kind,
      code: err.code,
      message: err.message,
      detail: err.detail.slice(0, 1000)
    })
  }
}

export function queueDepth(): number {
  return queue.length + (running ? 1 : 0)
}
