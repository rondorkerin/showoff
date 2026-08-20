import {
  DEFAULT_FRAME,
  FULL_FRAME,
  isVideoLane,
  type Aspect,
  type Lane,
  type LaneFrame,
  type Recording
} from '../../../shared/types.ts'

export { isVideoLane }

/** A frame set for 16:9 is in the wrong place in 9:16, so each aspect keeps
 * its own. Falls back to whatever was set before an aspect was chosen. */
export function frameFor(lane: Lane, aspect: Aspect): LaneFrame {
  const frames = lane.frame ?? {}
  const key = aspect === 'source' ? 'default' : aspect
  return (
    frames[key] ??
    frames.default ??
    (lane.kind === 'webcam' && lane.z > 0 ? DEFAULT_FRAME : FULL_FRAME)
  )
}

export function laneLength(lane: Lane, fallbackMs = 0): number {
  return Math.max(0, (lane.out_ms ?? lane.source_ms ?? fallbackMs) - lane.in_ms)
}

export function laneEnd(lane: Lane, fallbackMs = 0): number {
  return lane.offset_ms + laneLength(lane, fallbackMs)
}

/** The project runs until the last moment any lane is still playing. */
export function projectDuration(lanes: Lane[], fallbackMs = 0): number {
  let end = 0
  for (const l of lanes) end = Math.max(end, laneEnd(l, fallbackMs))
  return end || fallbackMs
}

/** Width divided by height, for sizing the preview canvas. */
export function ratioOf(aspect: Aspect, rec: Recording): number {
  switch (aspect) {
    case '16:9':
      return 16 / 9
    case '9:16':
      return 9 / 16
    case '1:1':
      return 1
    case '4:5':
      return 4 / 5
    default:
      return (rec.width || 16) / (rec.height || 9)
  }
}

export function laneTone(lane: Lane): { bar: string; text: string; ring: string } {
  return isVideoLane(lane.kind)
    ? { bar: 'rgba(76,141,255,0.22)', text: '#8fb6ff', ring: 'rgba(76,141,255,0.5)' }
    : { bar: 'rgba(63,185,138,0.18)', text: '#63c9a2', ring: 'rgba(63,185,138,0.5)' }
}

export const LANE_ICON: Record<Lane['kind'], string> = {
  screen: '▢',
  webcam: '◉',
  mic: '🎙',
  system: '♪',
  voiceover: '✚'
}
