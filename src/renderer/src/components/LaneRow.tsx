import React, { useRef, useState } from 'react'
import { cls, fmtClock } from '../lib/format.ts'
import { LANE_ICON, isVideoLane, laneLength, laneTone } from '../lib/lanes.ts'
import type { Lane, LanePatch } from '../../../shared/types.ts'

type Grab = 'move' | 'in' | 'out'

interface Live {
  grab: Grab
  startX: number
  offset: number
  in: number
  out: number
}

/**
 * One lane, one clip, one bar. Drag the bar to place it in time, drag an edge
 * to trim it. There is deliberately no way to put a second clip on the same
 * lane: lanes are free, and that one constraint is what keeps this an editor
 * instead of a non-linear editor with a selection model and an undo stack.
 */
export default function LaneRow({
  lane,
  durationMs,
  selected,
  onSelect,
  onPatch,
  onDelete
}: {
  lane: Lane
  durationMs: number
  selected: boolean
  onSelect: () => void
  onPatch: (patch: LanePatch) => void
  onDelete: () => void
}): React.ReactElement {
  const track = useRef<HTMLDivElement>(null)
  const [live, setLive] = useState<Live | null>(null)
  const tone = laneTone(lane)

  const sourceMs = lane.source_ms ?? durationMs
  const offset = live?.offset ?? lane.offset_ms
  const inMs = live?.in ?? lane.in_ms
  const outMs = live?.out ?? lane.out_ms ?? sourceMs
  const length = Math.max(0, outMs - inMs)
  const span = Math.max(1, durationMs)

  const begin = (e: React.PointerEvent, grab: Grab): void => {
    e.preventDefault()
    e.stopPropagation()
    onSelect()
    ;(e.target as HTMLElement).setPointerCapture(e.pointerId)
    setLive({
      grab,
      startX: e.clientX,
      offset: lane.offset_ms,
      in: lane.in_ms,
      out: lane.out_ms ?? sourceMs
    })
  }

  const move = (e: React.PointerEvent): void => {
    if (!live || !track.current) return
    const px = track.current.getBoundingClientRect().width
    const d = ((e.clientX - live.startX) / px) * span
    if (live.grab === 'move') {
      setLive({ ...live, offset: Math.max(0, Math.round(live.offset + d)) })
    } else if (live.grab === 'in') {
      // Trimming the head moves the clip with it, so the frames that stay put
      // stay put -- otherwise every trim silently re-times the whole edit.
      const next = Math.max(0, Math.min(live.out - 200, Math.round(live.in + d)))
      setLive({ ...live, in: next, offset: Math.max(0, live.offset + (next - live.in)) })
    } else {
      setLive({ ...live, out: Math.max(live.in + 200, Math.min(sourceMs, Math.round(live.out + d))) })
    }
  }

  const end = (): void => {
    if (!live) return
    const patch: LanePatch = {}
    if (live.offset !== lane.offset_ms) patch.offsetMs = live.offset
    if (live.in !== lane.in_ms) patch.inMs = live.in
    if (live.out !== (lane.out_ms ?? sourceMs)) patch.outMs = live.out
    setLive(null)
    if (Object.keys(patch).length > 0) onPatch(patch)
  }

  return (
    <div
      className={cls(
        'group grid grid-cols-[168px_1fr] items-center gap-3 rounded-[8px] px-2 py-1.5',
        selected ? 'bg-[#15181d]' : 'hover:bg-[#12151a]'
      )}
      onPointerDown={onSelect}
    >
      <div className="flex min-w-0 items-center gap-2">
        <button
          onClick={(e) => {
            e.stopPropagation()
            onPatch({ enabled: !lane.enabled })
          }}
          title={lane.enabled ? 'Mute this lane' : 'Unmute this lane'}
          aria-label={`${lane.enabled ? 'Disable' : 'Enable'} ${lane.label}`}
          className={cls(
            'grid h-6 w-6 shrink-0 place-items-center rounded-[6px] text-[12px] transition-colors',
            lane.enabled ? 'text-[#c8ccd2] hover:bg-[#1d2026]' : 'text-[#4c525b] hover:bg-[#1d2026]'
          )}
          style={{ color: lane.enabled ? tone.text : undefined }}
        >
          {LANE_ICON[lane.kind]}
        </button>
        <input
          value={lane.label}
          onChange={(e) => onPatch({ label: e.target.value })}
          aria-label="Lane name"
          className={cls(
            'min-w-0 flex-1 bg-transparent text-[12.5px] outline-none',
            lane.enabled ? 'text-[#c8ccd2]' : 'text-[#565d68] line-through'
          )}
        />
        <span className="mono shrink-0 text-[10.5px] text-[#565d68]">
          {isVideoLane(lane.kind) ? 'v' : `${Number(lane.gain).toFixed(1)}×`}
        </span>
      </div>

      <div
        ref={track}
        className="relative h-9 rounded-[6px] bg-[#0f1115]"
        onPointerMove={move}
        onPointerUp={end}
        onPointerCancel={end}
      >
        <div
          role="button"
          tabIndex={0}
          aria-label={`${lane.label}, from ${fmtClock(offset)} to ${fmtClock(offset + length)}`}
          onPointerDown={(e) => begin(e, 'move')}
          onKeyDown={(e) => {
            const step = e.shiftKey ? 1000 : 40
            if (e.key === 'ArrowLeft') onPatch({ offsetMs: Math.max(0, lane.offset_ms - step) })
            if (e.key === 'ArrowRight') onPatch({ offsetMs: lane.offset_ms + step })
          }}
          className={cls(
            'absolute inset-y-0 cursor-grab rounded-[6px] active:cursor-grabbing',
            selected && 'outline outline-[1.5px] -outline-offset-[1.5px] outline-[#F5A524]',
            !lane.enabled && 'opacity-40'
          )}
          style={{
            left: `${(offset / span) * 100}%`,
            width: `${Math.max(0.5, (length / span) * 100)}%`,
            background: tone.bar,
            boxShadow: `inset 0 0 0 1px ${tone.ring}`
          }}
        >
          <span className="mono pointer-events-none absolute left-2 top-1/2 -translate-y-1/2 text-[10.5px] text-[#c8ccd2]">
            {fmtClock(length)}
          </span>
          <span
            onPointerDown={(e) => begin(e, 'in')}
            className="absolute inset-y-0 left-0 w-2 cursor-ew-resize rounded-l-[6px] hover:bg-white/15"
          />
          <span
            onPointerDown={(e) => begin(e, 'out')}
            className="absolute inset-y-0 right-0 w-2 cursor-ew-resize rounded-r-[6px] hover:bg-white/15"
          />
        </div>
        <button
          onClick={(e) => {
            e.stopPropagation()
            onDelete()
          }}
          aria-label={`Remove ${lane.label}`}
          className="absolute right-1 top-1/2 hidden -translate-y-1/2 rounded-[5px] px-1.5 py-0.5 text-[11px] text-[#6b727d] hover:bg-[#1d2026] hover:text-[#e9eaec] group-hover:block"
        >
          ✕
        </button>
      </div>
    </div>
  )
}
