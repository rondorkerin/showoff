import React, { useEffect, useRef, useState } from 'react'
import { api } from '../lib/api.ts'
import { cls } from '../lib/format.ts'
import { frameFor, isVideoLane, laneLength } from '../lib/lanes.ts'
import type { Aspect, Lane, LaneFrame } from '../../../shared/types.ts'

interface DragState {
  laneId: string
  startX: number
  startY: number
  from: LaneFrame
  now: LaneFrame
}

/**
 * The preview is the browser, not ffmpeg.
 *
 * One <video> or <audio> element per lane, positioned by the same frame the
 * exporter uses and driven off a single clock, so what you see here is the
 * arrangement that gets rendered -- without waiting for a render to find out.
 * The clock lives in the editor and arrives as a ref: syncing on every React
 * render would mean a re-render every frame for no visual gain.
 */
export default function Preview({
  lanes,
  aspect,
  ratio,
  playing,
  silent,
  positionRef,
  durationMs,
  seekTick,
  selectedId,
  poster,
  onSelect,
  onFrame,
  onScrub
}: {
  lanes: Lane[]
  aspect: Aspect
  ratio: number
  playing: boolean
  /** Monitoring off -- used while a voice-over is being recorded, so the
   * existing audio cannot bleed into the take. */
  silent: boolean
  positionRef: React.MutableRefObject<number>
  durationMs: number
  seekTick: number
  selectedId: string | null
  poster: string | null
  onSelect: (id: string) => void
  onFrame: (laneId: string, frame: LaneFrame) => void
  onScrub: (ms: number) => void
}): React.ReactElement {
  const media = useRef(new Map<string, HTMLMediaElement>())
  const box = useRef<HTMLDivElement>(null)
  const [drag, setDrag] = useState<DragState | null>(null)

  const videoLanes = lanes.filter((l) => isVideoLane(l.kind))
  const audioLanes = lanes.filter((l) => !isVideoLane(l.kind))

  // One loop keeps every element on the project clock. Elements that fall
  // outside their own window are paused rather than muted, so a 40 minute
  // project does not decode ten streams to throw nine of them away.
  useEffect(() => {
    let raf = 0
    const tick = (): void => {
      const t = positionRef.current
      for (const lane of lanes) {
        const el = media.current.get(lane.id)
        if (!el) continue
        const len = laneLength(lane, durationMs)
        const active = lane.enabled && t >= lane.offset_ms && t < lane.offset_ms + len
        const local = (t - lane.offset_ms + lane.in_ms) / 1000
        el.volume =
          silent || isVideoLane(lane.kind) ? 0 : Math.max(0, Math.min(1, Number(lane.gain)))
        if (!active) {
          if (!el.paused) el.pause()
        } else if (playing) {
          if (Math.abs(el.currentTime - local) > 0.25) el.currentTime = local
          if (el.paused) void el.play().catch(() => undefined)
        } else {
          if (!el.paused) el.pause()
          if (Math.abs(el.currentTime - local) > 0.04) el.currentTime = local
        }
      }
      raf = requestAnimationFrame(tick)
    }
    raf = requestAnimationFrame(tick)
    return () => cancelAnimationFrame(raf)
  }, [lanes, playing, silent, durationMs, positionRef, seekTick])

  const beginDrag = (e: React.PointerEvent, lane: Lane): void => {
    if (!isVideoLane(lane.kind)) return
    e.preventDefault()
    onSelect(lane.id)
    const from = frameFor(lane, aspect)
    ;(e.target as HTMLElement).setPointerCapture(e.pointerId)
    setDrag({ laneId: lane.id, startX: e.clientX, startY: e.clientY, from, now: from })
  }

  const moveDrag = (e: React.PointerEvent): void => {
    if (!drag || !box.current) return
    const r = box.current.getBoundingClientRect()
    const now = {
      ...drag.from,
      x: clamp01(drag.from.x + (e.clientX - drag.startX) / r.width),
      y: clamp01(drag.from.y + (e.clientY - drag.startY) / r.height)
    }
    setDrag({ ...drag, now })
  }

  const endDrag = (): void => {
    if (drag && (drag.now.x !== drag.from.x || drag.now.y !== drag.from.y)) {
      onFrame(drag.laneId, drag.now)
    }
    setDrag(null)
  }

  const frameOf = (lane: Lane): LaneFrame =>
    drag && drag.laneId === lane.id ? drag.now : frameFor(lane, aspect)

  return (
    <div className="flex min-h-0 flex-1 flex-col items-center justify-center gap-3">
      <div
        ref={box}
        className="relative max-h-full overflow-hidden rounded-[10px] border border-[#262a31] bg-black"
        style={{ aspectRatio: String(ratio), width: ratio >= 1 ? '100%' : 'auto', height: ratio >= 1 ? 'auto' : '100%' }}
        onPointerMove={moveDrag}
        onPointerUp={endDrag}
        onPointerCancel={endDrag}
      >
        {videoLanes.length === 0 && (
          <div className="flex h-full w-full items-center justify-center text-[12px] text-[#6b727d]">
            No video lanes
          </div>
        )}
        {poster && videoLanes.length > 0 && (
          <img src={poster} alt="" className="pointer-events-none absolute inset-0 h-full w-full object-contain opacity-0" />
        )}
        {videoLanes.map((lane) => {
          const f = frameOf(lane)
          const selected = lane.id === selectedId
          return (
            <div
              key={lane.id}
              onPointerDown={(e) => beginDrag(e, lane)}
              className={cls(
                'absolute cursor-move',
                !lane.enabled && 'hidden',
                selected && 'outline outline-[1.5px] -outline-offset-[1.5px] outline-[#F5A524]'
              )}
              style={{
                left: `${f.x * 100}%`,
                top: `${f.y * 100}%`,
                width: `${f.scale * 100}%`,
                transform: 'translate(-50%, -50%)',
                zIndex: lane.z + 1
              }}
            >
              <video
                ref={(el) => {
                  if (el) media.current.set(lane.id, el)
                  else media.current.delete(lane.id)
                }}
                src={api.mediaUrl(lane.path)}
                muted
                playsInline
                preload="auto"
                className="pointer-events-none block w-full"
              />
            </div>
          )
        })}
      </div>

      {audioLanes.map((lane) => (
        <audio
          key={lane.id}
          ref={(el) => {
            if (el) media.current.set(lane.id, el)
            else media.current.delete(lane.id)
          }}
          src={api.mediaUrl(lane.path)}
          preload="auto"
          className="hidden"
        />
      ))}

      <Scrubber durationMs={durationMs} positionRef={positionRef} onScrub={onScrub} />
    </div>
  )
}

function clamp01(n: number): number {
  return Math.max(0, Math.min(1, n))
}

/** Reads the clock off the ref so the whole editor does not re-render at 60fps. */
function Scrubber({
  durationMs,
  positionRef,
  onScrub
}: {
  durationMs: number
  positionRef: React.MutableRefObject<number>
  onScrub: (ms: number) => void
}): React.ReactElement {
  const fill = useRef<HTMLDivElement>(null)
  const track = useRef<HTMLDivElement>(null)

  useEffect(() => {
    let raf = 0
    const tick = (): void => {
      if (fill.current && durationMs > 0) {
        fill.current.style.width = `${Math.min(100, (positionRef.current / durationMs) * 100)}%`
      }
      raf = requestAnimationFrame(tick)
    }
    raf = requestAnimationFrame(tick)
    return () => cancelAnimationFrame(raf)
  }, [durationMs, positionRef])

  const scrubTo = (clientX: number): void => {
    if (!track.current || durationMs <= 0) return
    const r = track.current.getBoundingClientRect()
    onScrub(Math.max(0, Math.min(durationMs, ((clientX - r.left) / r.width) * durationMs)))
  }

  return (
    <div
      ref={track}
      role="slider"
      tabIndex={0}
      aria-label="Playhead"
      aria-valuemin={0}
      aria-valuemax={Math.round(durationMs)}
      aria-valuenow={Math.round(positionRef.current)}
      onPointerDown={(e) => {
        ;(e.target as HTMLElement).setPointerCapture(e.pointerId)
        scrubTo(e.clientX)
      }}
      onPointerMove={(e) => e.buttons === 1 && scrubTo(e.clientX)}
      className="h-[6px] w-full shrink-0 cursor-pointer rounded-full bg-[#1d2026]"
    >
      <div ref={fill} className="h-full rounded-full bg-[#F5A524]" style={{ width: '0%' }} />
    </div>
  )
}
