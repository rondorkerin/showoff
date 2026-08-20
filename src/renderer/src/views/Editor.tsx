import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { api, soft } from '../lib/api.ts'
import { cls, fmtAgo, fmtClock } from '../lib/format.ts'
import { Badge, Button, Empty, Input, Select, Spinner, Toggle } from '../components/ui.tsx'
import { useToast } from '../components/Toasts.tsx'
import CutDialog from '../components/CutDialog.tsx'
import Voiceover from '../components/Voiceover.tsx'
import AddSource from '../components/AddSource.tsx'
import Preview from '../components/Preview.tsx'
import LaneRow from '../components/LaneRow.tsx'
import { ClipsTab, NotebookTab, TranscriptTab } from '../components/DetailTabs.tsx'
import { frameFor, isVideoLane, projectDuration, ratioOf } from '../lib/lanes.ts'
import { ASPECTS, byStackOrder, type Aspect, type Lane, type LanePatch } from '../../../shared/types.ts'
import type { Shell } from '../App.tsx'
import type { RecordingDetail as Detail } from '../../../preload/index.ts'
import type { PlatformId } from '../../../shared/platforms.ts'

type Panel = 'lane' | 'transcript' | 'clips' | 'notes'

/**
 * The editor is the recording. Everything the app can do downstream --
 * transcribe, cut, write notes -- hangs off the side of this screen as a
 * button, never as a gate in front of getting a file out.
 */
export default function Editor({ shell, id }: { shell: Shell; id: string }): React.ReactElement {
  const toast = useToast()
  const [detail, setDetail] = useState<Detail | null>(null)
  const [loading, setLoading] = useState(true)
  const [panel, setPanel] = useState<Panel>('lane')
  const [cutOpen, setCutOpen] = useState(false)
  const [addOpen, setAddOpen] = useState(false)
  const [title, setTitle] = useState('')
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [playing, setPlaying] = useState(false)
  const [positionMs, setPositionMs] = useState(0)
  const [seekTick, setSeekTick] = useState(0)
  const [silent, setSilent] = useState(false)
  const positionRef = useRef(0)

  const load = useCallback(async () => {
    const d = await soft(api.recordings.get(id), null)
    setDetail(d)
    if (d) setTitle(d.recording.title)
    setLoading(false)
  }, [id])

  useEffect(() => {
    setLoading(true)
    void load()
  }, [load])

  useEffect(() => {
    void load()
  }, [shell.jobTick, load])

  const lanes = useMemo(() => {
    const list = [...(detail?.lanes ?? [])]
    // Top of the stack at the top of the rail: the same order you see on the
    // canvas, so "above" means the same thing in both places.
    list.sort((a, b) => -byStackOrder(a, b))
    return list
  }, [detail])

  const rec = detail?.recording ?? null
  const aspect: Aspect = rec?.aspect ?? 'source'
  const durationMs = useMemo(
    () => projectDuration(detail?.lanes ?? [], rec?.duration_ms ?? 0),
    [detail, rec]
  )
  const selected = lanes.find((l) => l.id === selectedId) ?? null
  const activeJob = shell.jobs.find((j) => j.recordingId === id) ?? null

  /* ------------------------------------------------------------- playback */

  const seek = useCallback((ms: number) => {
    positionRef.current = Math.max(0, ms)
    setPositionMs(positionRef.current)
    setSeekTick((n) => n + 1)
  }, [])

  useEffect(() => {
    if (!playing) return
    const anchorWall = performance.now()
    const anchorPos = positionRef.current
    let raf = 0
    const tick = (): void => {
      const next = anchorPos + (performance.now() - anchorWall)
      if (next >= durationMs) {
        positionRef.current = durationMs
        setPositionMs(durationMs)
        setPlaying(false)
        return
      }
      positionRef.current = next
      setPositionMs(next)
      raf = requestAnimationFrame(tick)
    }
    raf = requestAnimationFrame(tick)
    return () => cancelAnimationFrame(raf)
  }, [playing, durationMs])

  const togglePlay = useCallback(() => {
    setPlaying((p) => {
      if (!p && positionRef.current >= durationMs - 20) seek(0)
      return !p
    })
  }, [durationMs, seek])

  // A voice-over narrates to picture, so it drives the same transport the
  // play button does rather than a second hidden one.
  const playback = useMemo(
    () => ({
      start: (): void => {
        seek(0)
        setSilent(true)
        setPlaying(true)
      },
      stop: (): void => {
        setPlaying(false)
        setSilent(false)
      }
    }),
    [seek]
  )

  /* -------------------------------------------------------------- editing */

  const patch = useCallback(
    async (laneId: string, p: LanePatch) => {
      // Optimistic: a fader that lags a round trip behind your finger is a
      // fader you stop trusting.
      setDetail((d) =>
        d
          ? { ...d, lanes: d.lanes.map((l) => (l.id === laneId ? applyPatch(l, p, aspect) : l)) }
          : d
      )
      await soft(api.lanes.update(laneId, { ...p, aspect }), null)
    },
    [aspect]
  )

  const removeLane = useCallback(
    async (laneId: string) => {
      setDetail((d) => (d ? { ...d, lanes: d.lanes.filter((l) => l.id !== laneId) } : d))
      if (selectedId === laneId) setSelectedId(null)
      await soft(api.lanes.remove(laneId), undefined)
      void load()
    },
    [load, selectedId]
  )

  const setAspect = async (next: Aspect): Promise<void> => {
    setDetail((d) => (d ? { ...d, recording: { ...d.recording, aspect: next } } : d))
    await soft(api.lanes.aspect(id, next), undefined)
  }

  const doExport = useCallback(async () => {
    const job = await soft(api.exports.mp4(id, undefined, false), null)
    if (job) toast.push({ tone: 'info', title: 'Exporting mp4' })
  }, [id, toast])

  /* ------------------------------------------------------------- keyboard */

  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      const el = e.target as HTMLElement | null
      if (el && (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.isContentEditable)) return
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'e') {
        e.preventDefault()
        void doExport()
        return
      }
      if (e.metaKey || e.ctrlKey || e.altKey) return
      if (e.key === ' ') {
        e.preventDefault()
        togglePlay()
      } else if (e.key === 'ArrowLeft') {
        e.preventDefault()
        seek(positionRef.current - (e.shiftKey ? 1000 : 40))
      } else if (e.key === 'ArrowRight') {
        e.preventDefault()
        seek(positionRef.current + (e.shiftKey ? 1000 : 40))
      } else if (selected && (e.key === 'm' || e.key === 'M' || e.key === 'v' || e.key === 'V')) {
        e.preventDefault()
        void patch(selected.id, { enabled: !selected.enabled })
      } else if (selected && (e.key === '[' || e.key === ']')) {
        e.preventDefault()
        const local = Math.round(positionRef.current - selected.offset_ms + selected.in_ms)
        if (e.key === '[') void patch(selected.id, { inMs: Math.max(0, local) })
        else void patch(selected.id, { outMs: Math.max(selected.in_ms + 200, local) })
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [doExport, patch, seek, selected, togglePlay])

  if (loading) {
    return (
      <div className="flex h-full items-center justify-center gap-2 text-[13px] text-[#9aa1ab]">
        <Spinner /> Loading recording…
      </div>
    )
  }

  if (!detail || !rec) {
    return (
      <div className="p-8 pt-[60px]">
        <Empty
          title="Recording not found"
          body="It may have been deleted from the library."
          action={<Button onClick={() => shell.go({ name: 'library' })}>Back to library</Button>}
        />
      </div>
    )
  }

  return (
    <div className="flex h-full flex-col">
      <header className="drag-region shrink-0 border-b border-[#1d2026] px-6 pb-3 pt-[34px]">
        <div className="no-drag flex items-center gap-3">
          <Button size="sm" variant="ghost" onClick={() => shell.go({ name: 'library' })}>
            ← Library
          </Button>
          <input
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            onBlur={async () => {
              if (title !== rec.title) {
                await soft(api.recordings.update({ id, title }), undefined)
                void load()
              }
            }}
            onKeyDown={(e) => e.key === 'Enter' && e.currentTarget.blur()}
            aria-label="Recording title"
            className="min-w-0 flex-1 bg-transparent text-[16px] font-semibold tracking-tight outline-none focus:text-white"
          />
          <div className="flex shrink-0 items-center gap-1 rounded-[8px] border border-[#262a31] p-0.5">
            {ASPECTS.map((a) => (
              <button
                key={a}
                onClick={() => void setAspect(a)}
                className={cls(
                  'mono rounded-[6px] px-2 py-1 text-[11px] transition-colors',
                  aspect === a ? 'bg-[#1d2026] text-[#e9eaec]' : 'text-[#6b727d] hover:text-[#c8ccd2]'
                )}
              >
                {a}
              </button>
            ))}
          </div>
          <Button size="sm" variant="ghost" onClick={() => setAddOpen(true)}>
            + Add source
          </Button>
          <Button size="sm" variant="primary" onClick={() => void doExport()}>
            Export mp4
          </Button>
        </div>

        <div className="no-drag mt-2.5 flex flex-wrap items-center gap-2 text-[11.5px] text-[#6b727d]">
          <span>{fmtAgo(rec.created_at)}</span>
          <span>·</span>
          <span className="mono">{fmtClock(durationMs)}</span>
          <span>·</span>
          <span>
            {lanes.length} lane{lanes.length === 1 ? '' : 's'}
          </span>
          {detail.transcript && (
            <>
              <span>·</span>
              <Badge tone="good">transcribed</Badge>
            </>
          )}
          {rec.status === 'failed' && <Badge tone="bad">{rec.error ?? 'failed'}</Badge>}
          {activeJob && (
            <>
              <span>·</span>
              <span className="text-[#F5A524]">
                {activeJob.stage ?? 'Working'} · {Math.round((activeJob.progress ?? 0) * 100)}%
              </span>
            </>
          )}
        </div>
      </header>

      <div className="grid min-h-0 flex-1 grid-cols-[1fr_320px]">
        <div className="flex min-h-0 flex-col">
          <div className="flex min-h-0 flex-1 items-center justify-center p-6">
            <Preview
              lanes={lanes}
              aspect={aspect}
              ratio={ratioOf(aspect, rec)}
              playing={playing}
              silent={silent}
              positionRef={positionRef}
              durationMs={durationMs}
              seekTick={seekTick}
              selectedId={selectedId}
              poster={rec.poster_path ? api.mediaUrl(rec.poster_path) : null}
              onSelect={setSelectedId}
              onFrame={(laneId, frame) => void patch(laneId, { frame })}
              onScrub={seek}
            />
          </div>

          <div className="flex shrink-0 items-center gap-3 border-t border-[#1d2026] px-6 py-2">
            <Button size="sm" variant="primary" onClick={togglePlay}>
              {playing ? '❚❚ Pause' : '▶ Play'}
            </Button>
            <span className="mono text-[12px] text-[#c8ccd2]">
              {fmtClock(positionMs)} <span className="text-[#565d68]">/ {fmtClock(durationMs)}</span>
            </span>
            <span className="flex-1" />
            <span className="text-[11px] text-[#565d68]">
              space play · ←/→ nudge · [ ] trim · M mute · ⌘E export
            </span>
          </div>

          <div className="max-h-[38%] shrink-0 overflow-y-auto border-t border-[#1d2026] px-4 py-3">
            {lanes.length === 0 ? (
              <div className="px-2 py-6 text-center text-[12px] text-[#6b727d]">
                This recording has no lanes on disk.
              </div>
            ) : (
              <div className="flex flex-col gap-1">
                {lanes.map((lane) => (
                  <LaneRow
                    key={lane.id}
                    lane={lane}
                    durationMs={durationMs}
                    selected={lane.id === selectedId}
                    onSelect={() => setSelectedId(lane.id)}
                    onPatch={(p) => void patch(lane.id, p)}
                    onDelete={() => void removeLane(lane.id)}
                  />
                ))}
              </div>
            )}
          </div>
        </div>

        {/* ---------------------------------------------------------- panel */}
        <div className="flex min-h-0 flex-col border-l border-[#1d2026]">
          <div className="flex shrink-0 items-center gap-1 border-b border-[#1d2026] px-4 pt-3">
            {(['lane', 'transcript', 'clips', 'notes'] as Panel[]).map((p) => (
              <button
                key={p}
                onClick={() => setPanel(p)}
                className={cls(
                  'relative px-2.5 pb-2.5 pt-1 text-[12.5px] capitalize transition-colors',
                  panel === p ? 'text-[#e9eaec]' : 'text-[#6b727d] hover:text-[#9aa1ab]'
                )}
              >
                {p}
                {p === 'clips' && detail.clips.length > 0 && (
                  <span className="mono ml-1.5 text-[11px] text-[#6b727d]">{detail.clips.length}</span>
                )}
                {panel === p && (
                  <span className="absolute inset-x-2 -bottom-px h-[2px] rounded-full bg-[#F5A524]" />
                )}
              </button>
            ))}
          </div>

          <div className="min-h-0 flex-1 overflow-y-auto p-4">
            {panel === 'lane' && (
              <Inspector
                lane={selected}
                aspect={aspect}
                durationMs={durationMs}
                onPatch={(p) => selected && void patch(selected.id, p)}
              />
            )}
            {panel === 'transcript' && (
              <div className="flex flex-col gap-3">
                <div className="flex flex-wrap gap-2">
                  <Button
                    size="sm"
                    onClick={async () => {
                      await soft(api.pipeline.transcribe(id), null)
                      toast.push({ tone: 'info', title: 'Transcribing' })
                    }}
                    disabled={!!activeJob}
                  >
                    {detail.transcript ? 'Re-transcribe' : 'Transcribe'}
                  </Button>
                  <Button
                    size="sm"
                    variant="ghost"
                    onClick={() => void soft(api.exports.mp4(id, undefined, true), null)}
                    disabled={!detail.transcript}
                    title={detail.transcript ? '' : 'Transcribe first'}
                  >
                    Export with subtitles
                  </Button>
                </div>
                <TranscriptTab detail={detail} position={positionMs} onSeek={seek} />
              </div>
            )}
            {panel === 'clips' && (
              <div className="flex flex-col gap-3">
                <Button
                  size="sm"
                  variant="primary"
                  onClick={() => setCutOpen(true)}
                  disabled={!detail.transcript || !!activeJob}
                  title={detail.transcript ? '' : 'Transcribe first — the cut is driven by what you said'}
                >
                  Chop into clips
                </Button>
                <ClipsTab
                  detail={detail}
                  rendersByClip={rendersByClip(detail)}
                  onCut={() => setCutOpen(true)}
                  onChanged={load}
                  working={!!activeJob}
                />
              </div>
            )}
            {panel === 'notes' && (
              <div className="flex h-full flex-col gap-3">
                <Button
                  size="sm"
                  onClick={async () => {
                    await soft(api.pipeline.notes(id), null)
                    toast.push({ tone: 'info', title: 'Writing notes' })
                  }}
                  disabled={!detail.transcript || !!activeJob}
                >
                  Generate notes
                </Button>
                <NotebookTab detail={detail} onSaved={load} />
              </div>
            )}
          </div>

          <div className="shrink-0 border-t border-[#1d2026] p-4">
            <Voiceover
              recordingId={id}
              hasVoiceover={lanes.some((l) => l.kind === 'voiceover')}
              playback={playback}
              onSaved={load}
            />
            <div className="mt-3 flex flex-wrap gap-2">
              <Button size="sm" variant="ghost" onClick={() => void soft(api.shell.showItem(rec.dir), false)}>
                Show files
              </Button>
              <Button
                size="sm"
                variant="danger"
                onClick={async () => {
                  if (!confirm(`Delete "${rec.title}"? The files stay on disk in ${rec.dir}.`)) return
                  await soft(api.recordings.remove(id), undefined)
                  shell.go({ name: 'library' })
                }}
              >
                Delete
              </Button>
            </div>
          </div>
        </div>
      </div>

      <CutDialog
        open={cutOpen}
        onClose={() => setCutOpen(false)}
        recordingId={id}
        defaultPlatforms={(shell.settings?.platforms as PlatformId[]) ?? ['x', 'linkedin', 'youtube_short']}
        defaultMaxClips={shell.settings?.maxClips ?? 4}
        onStarted={() => toast.push({ tone: 'info', title: 'Cutting clips' })}
      />
      <AddSource open={addOpen} onClose={() => setAddOpen(false)} recordingId={id} onAdded={load} />
    </div>
  )
}

function rendersByClip(detail: Detail): Map<string, Detail['renders'][number]> {
  const map = new Map<string, Detail['renders'][number]>()
  for (const r of detail.renders) map.set(r.clip_id, r)
  return map
}

/** Optimistic local copy of what the main process is about to persist. */
function applyPatch(lane: Lane, p: LanePatch, aspect: Aspect): Lane {
  const next: Lane = { ...lane }
  if (p.label !== undefined) next.label = p.label
  if (p.offsetMs !== undefined) next.offset_ms = p.offsetMs
  if (p.inMs !== undefined) next.in_ms = p.inMs
  if (p.outMs !== undefined) next.out_ms = p.outMs
  if (p.z !== undefined) next.z = p.z
  if (p.enabled !== undefined) next.enabled = p.enabled
  if (p.gain !== undefined) next.gain = p.gain
  if (p.ducks !== undefined) next.ducks = p.ducks
  if (p.frame) {
    next.frame = { ...(lane.frame ?? {}), [aspect === 'source' ? 'default' : aspect]: p.frame }
  }
  return next
}

function Inspector({
  lane,
  aspect,
  durationMs,
  onPatch
}: {
  lane: Lane | null
  aspect: Aspect
  durationMs: number
  onPatch: (p: LanePatch) => void
}): React.ReactElement {
  if (!lane) {
    return (
      <div className="px-1 py-6 text-[12px] leading-relaxed text-[#6b727d]">
        Pick a lane below or on the canvas. Video lanes carry position, size and
        stacking order; audio lanes carry level and ducking.
      </div>
    )
  }
  const frame = frameFor(lane, aspect)
  const video = isVideoLane(lane.kind)
  const length = (lane.out_ms ?? lane.source_ms ?? durationMs) - lane.in_ms

  return (
    <div className="flex flex-col gap-4">
      <div>
        <div className="mb-1 text-[11px] uppercase tracking-wide text-[#6b727d]">Lane</div>
        <Input value={lane.label} onChange={(e) => onPatch({ label: e.target.value })} />
        <div className="mono mt-1.5 text-[11px] text-[#565d68]">
          {lane.kind} · {fmtClock(length)} · starts {fmtClock(lane.offset_ms)}
        </div>
      </div>

      <Toggle
        label="Included in the export"
        checked={lane.enabled}
        onChange={(v) => onPatch({ enabled: v })}
      />

      {video ? (
        <>
          <Slider
            label="Size"
            value={frame.scale}
            min={0.08}
            max={1}
            step={0.01}
            format={(v) => `${Math.round(v * 100)}%`}
            onChange={(v) => onPatch({ frame: { ...frame, scale: v } })}
          />
          <div className="flex gap-2">
            <Button size="sm" variant="ghost" onClick={() => onPatch({ frame: { x: 0.5, y: 0.5, scale: 1 } })}>
              Fill frame
            </Button>
            <Button
              size="sm"
              variant="ghost"
              onClick={() => onPatch({ frame: { x: 0.86, y: 0.85, scale: 0.24 } })}
            >
              Corner
            </Button>
          </div>
          <div className="flex items-center gap-2">
            <Button size="sm" variant="ghost" onClick={() => onPatch({ z: lane.z + 1 })}>
              Bring forward
            </Button>
            <Button size="sm" variant="ghost" onClick={() => onPatch({ z: Math.max(0, lane.z - 1) })}>
              Send back
            </Button>
          </div>
          <p className="text-[11.5px] leading-relaxed text-[#6b727d]">
            Drag the lane on the canvas to move it. Position is remembered per
            aspect, so reframing for 9:16 leaves your 16:9 layout alone.
          </p>
        </>
      ) : (
        <>
          <Slider
            label="Level"
            value={Number(lane.gain)}
            min={0}
            max={2}
            step={0.05}
            format={(v) => `${v.toFixed(2)}×`}
            onChange={(v) => onPatch({ gain: v })}
          />
          <Toggle
            label="Duck everything else under this"
            checked={lane.ducks}
            onChange={(v) => onPatch({ ducks: v })}
          />
          <p className="text-[11.5px] leading-relaxed text-[#6b727d]">
            Ducking pulls the other audio lanes down only while this one has
            speech in it, which is what a fixed level cannot do.
          </p>
        </>
      )}
    </div>
  )
}

function Slider({
  label,
  value,
  min,
  max,
  step,
  format,
  onChange
}: {
  label: string
  value: number
  min: number
  max: number
  step: number
  format: (v: number) => string
  onChange: (v: number) => void
}): React.ReactElement {
  return (
    <label className="flex flex-col gap-1.5">
      <span className="flex items-baseline justify-between text-[11px] uppercase tracking-wide text-[#6b727d]">
        {label}
        <span className="mono normal-case tracking-normal text-[#c8ccd2]">{format(value)}</span>
      </span>
      <input
        type="range"
        min={min}
        max={max}
        step={step}
        value={value}
        onChange={(e) => onChange(Number(e.target.value))}
        className="accent-[#F5A524]"
      />
    </label>
  )
}
