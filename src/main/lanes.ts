import { existsSync } from 'node:fs'
import { basename, dirname, join } from 'node:path'
import * as repo from './db/repo.ts'
import type { CompositeLane } from './media/render.ts'
import {
  DEFAULT_FRAME,
  FULL_FRAME,
  byStackOrder,
  isVideoLane,
  type Aspect,
  type Lane,
  type LaneFrame,
  type Recording
} from '../shared/types.ts'
import { log } from './log.ts'

/** Fixed output sizes per aspect. Predictable beats clever: you always know
 * what a 9:16 export is going to be before you press the button. */
const SIZES: Record<Exclude<Aspect, 'source'>, { width: number; height: number }> = {
  '16:9': { width: 1920, height: 1080 },
  '9:16': { width: 1080, height: 1920 },
  '1:1': { width: 1080, height: 1080 },
  '4:5': { width: 1080, height: 1350 }
}

export function outputSize(rec: Recording, aspect?: Aspect): { width: number; height: number } {
  const a = aspect ?? rec.aspect ?? 'source'
  if (a !== 'source') return SIZES[a]
  return { width: rec.width || 1920, height: rec.height || 1080 }
}

/** A frame set for 16:9 is in the wrong place in 9:16, so each aspect keeps its
 * own. Fall back to whatever was set before the user picked an aspect. */
export function resolveFrame(lane: Lane, aspect: Aspect): LaneFrame {
  const frames = lane.frame ?? {}
  const key = aspect === 'source' ? 'default' : aspect
  return (
    frames[key] ??
    frames.default ??
    (lane.kind === 'webcam' && lane.z > 0 ? DEFAULT_FRAME : FULL_FRAME)
  )
}

/** How long the project runs: the last moment any lane is still playing. */
export function projectDurationMs(lanes: Lane[], fallbackMs = 0): number {
  let end = 0
  for (const l of lanes) {
    const len = (l.out_ms ?? l.source_ms ?? fallbackMs) - l.in_ms
    if (len > 0) end = Math.max(end, l.offset_ms + len)
  }
  return end || fallbackMs
}

/** Lanes as the compositor wants them: enabled only, z order, frame resolved. */
export function toComposite(lanes: Lane[], aspect: Aspect): CompositeLane[] {
  return lanes
    .filter((l) => l.enabled)
    .slice()
    .sort(byStackOrder)
    .map((l) => ({
      kind: l.kind,
      path: l.path,
      offsetMs: l.offset_ms,
      inMs: l.in_ms,
      outMs: l.out_ms,
      sourceMs: l.source_ms,
      gain: Number(l.gain),
      ducks: l.ducks,
      frame: resolveFrame(l, aspect)
    }))
}

/** The lane whose audio best represents what was said: a voice-over if there is
 * one, then the mic, then anything else that carries sound. */
export function narrationLane(lanes: Lane[]): Lane | null {
  const enabled = lanes.filter((l) => l.enabled && existsSync(l.path))
  return (
    enabled.find((l) => l.kind === 'voiceover') ??
    enabled.find((l) => l.kind === 'mic') ??
    enabled.find((l) => !isVideoLane(l.kind)) ??
    enabled.find((l) => l.kind === 'screen') ??
    enabled[0] ??
    null
  )
}

/**
 * Repairs lanes carried over from before the editor existed.
 *
 * Up to v0.1.3 finalize baked the mic into a single master.mp4 and recorded it
 * as the screen track, so a straight migration would give an old recording a
 * screen lane with the narration welded into it *and* a separate mic lane --
 * every export would play the voice twice. SQL cannot look at the disk, so the
 * fix runs here, where it can: prefer the separate screen.mp4 that finalize
 * also wrote, and where that is missing, drop the duplicate mic lane instead.
 *
 * Idempotent, and cheap enough to run every time a recording is opened.
 */
export async function reconcileLanes(recordingId: string): Promise<Lane[]> {
  let lanes = await repo.listLanes(recordingId)
  if (lanes.length === 0) return lanes
  let changed = false

  let micDropped = false
  const screen = lanes.find((l) => l.kind === 'screen')
  const mic = lanes.find((l) => l.kind === 'mic')

  if (screen && basename(screen.path) === 'master.mp4') {
    const split = join(dirname(screen.path), 'screen.mp4')
    if (existsSync(split)) {
      await repo.setLanePath(screen.id, split)
      changed = true
      log.info('lanes', 'repointed legacy master to the split screen track', { recordingId })
    } else if (mic) {
      await repo.deleteLane(mic.id)
      micDropped = true
      changed = true
      log.info('lanes', 'dropped a mic lane already baked into master.mp4', { recordingId })
    }
  }

  // The old code stored the raw mic .webm; the .m4a beside it seeks properly.
  const micNow = micDropped ? null : mic
  if (micNow && micNow.path.endsWith('.webm')) {
    const m4a = micNow.path.replace(/\.webm$/, '.m4a')
    if (existsSync(m4a)) {
      await repo.setLanePath(micNow.id, m4a)
      changed = true
    }
  }

  if (changed) lanes = await repo.listLanes(recordingId)
  return lanes
}

/** Which stored frame set a given output size should use. */
export function aspectForSize(width: number, height: number): Aspect {
  const r = width / height
  const near = (target: number): boolean => Math.abs(r - target) < 0.02
  if (near(16 / 9)) return '16:9'
  if (near(9 / 16)) return '9:16'
  if (near(1)) return '1:1'
  if (near(4 / 5)) return '4:5'
  return 'source'
}
