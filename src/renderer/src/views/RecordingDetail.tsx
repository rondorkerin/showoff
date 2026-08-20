import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { api, must, soft } from '../lib/api.ts'
import { cls, fmtAgo, fmtClock, fmtDuration } from '../lib/format.ts'
import { Badge, Button, Empty, Input, Select, Spinner } from '../components/ui.tsx'
import { useToast } from '../components/Toasts.tsx'
import ClipCard, { ClipSkeleton } from '../components/ClipCard.tsx'
import CutDialog from '../components/CutDialog.tsx'
import type { Shell } from '../App.tsx'
import type { RecordingDetail as Detail } from '../../../preload/index.ts'
import type { PlatformId } from '../../../shared/platforms.ts'

type Tab = 'transcript' | 'notebook' | 'clips'

export default function RecordingDetail({
  shell,
  id
}: {
  shell: Shell
  id: string
}): React.ReactElement {
  const toast = useToast()
  const [detail, setDetail] = useState<Detail | null>(null)
  const [loading, setLoading] = useState(true)
  const [tab, setTab] = useState<Tab>('clips')
  const [cutOpen, setCutOpen] = useState(false)
  const [title, setTitle] = useState('')
  const [tagInput, setTagInput] = useState('')
  const videoRef = useRef<HTMLVideoElement>(null)
  const [position, setPosition] = useState(0)

  const load = useCallback(async () => {
    const d = await soft(api.recordings.get(id), null)
    setDetail(d)
    if (d) setTitle(d.recording.title)
    if (d) setTagInput(d.tags.join(', '))
    setLoading(false)
    // Land on whatever is actually there: clips if cut, transcript if
    // transcribed, otherwise the empty clips tab with its call to action.
    setTab((t) => (t === 'clips' && d && d.clips.length === 0 && d.transcript ? 'transcript' : t))
  }, [id])

  useEffect(() => {
    setLoading(true)
    void load()
  }, [load])

  useEffect(() => {
    void load()
  }, [shell.jobTick, load])

  const activeJob = shell.jobs.find((j) => j.recordingId === id) ?? null
  const master = detail?.tracks.find((t) => t.kind === 'screen') ?? detail?.tracks[0] ?? null
  const rendersByClip = useMemo(() => {
    const map = new Map<string, Detail['renders'][number]>()
    for (const r of detail?.renders ?? []) map.set(r.clip_id, r)
    return map
  }, [detail])

  const seek = (ms: number): void => {
    if (!videoRef.current) return
    videoRef.current.currentTime = ms / 1000
    void videoRef.current.play()
  }

  const saveTitle = async (): Promise<void> => {
    if (!detail || title === detail.recording.title) return
    await soft(api.recordings.update({ id, title }), undefined)
    void load()
  }

  const saveTags = async (): Promise<void> => {
    const tags = tagInput
      .split(',')
      .map((t) => t.trim())
      .filter(Boolean)
    await soft(api.recordings.setTags(id, tags), undefined)
    void load()
  }

  if (loading) {
    return (
      <div className="flex h-full items-center justify-center gap-2 text-[13px] text-[#9aa1ab]">
        <Spinner /> Loading recording…
      </div>
    )
  }

  if (!detail) {
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

  const rec = detail.recording

  return (
    <div className="flex h-full flex-col">
      <header className="drag-region border-b border-[#1d2026] px-8 pb-3 pt-[34px]">
        <div className="no-drag flex items-center gap-3">
          <Button size="sm" variant="ghost" onClick={() => shell.go({ name: 'library' })}>
            ← Library
          </Button>
          <input
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            onBlur={() => void saveTitle()}
            onKeyDown={(e) => e.key === 'Enter' && e.currentTarget.blur()}
            className="min-w-0 flex-1 bg-transparent text-[16px] font-semibold tracking-tight outline-none focus:text-white"
          />
          <Select
            value={rec.project_id ?? ''}
            onChange={async (e) => {
              await soft(api.recordings.update({ id, projectId: e.target.value || null }), undefined)
              void load()
            }}
            className="w-[160px] py-1.5 text-[12px]"
          >
            <option value="">No project</option>
            {shell.projects.map((p) => (
              <option key={p.id} value={p.id}>
                {p.name}
              </option>
            ))}
          </Select>
        </div>

        <div className="no-drag mt-2.5 flex flex-wrap items-center gap-2 text-[11.5px] text-[#6b727d]">
          <span>{fmtAgo(rec.created_at)}</span>
          <span>·</span>
          <span className="mono">{fmtDuration(rec.duration_ms)}</span>
          {rec.width && (
            <>
              <span>·</span>
              <span className="mono">
                {rec.width}×{rec.height}
              </span>
            </>
          )}
          <span>·</span>
          <span>{detail.tracks.length} track{detail.tracks.length === 1 ? '' : 's'}</span>
          {detail.transcript && (
            <>
              <span>·</span>
              <Badge tone="good">transcribed</Badge>
            </>
          )}
          {rec.status === 'failed' && <Badge tone="bad">{rec.error ?? 'failed'}</Badge>}
          <span className="flex-1" />
          <Input
            value={tagInput}
            onChange={(e) => setTagInput(e.target.value)}
            onBlur={() => void saveTags()}
            placeholder="tags, comma separated"
            className="w-[220px] py-1 text-[11.5px]"
          />
        </div>
      </header>

      <div className="grid min-h-0 flex-1 grid-cols-[minmax(360px,42%)_1fr]">
        {/* ------------------------------------------------------- player */}
        <div className="flex min-h-0 flex-col gap-3 overflow-y-auto border-r border-[#1d2026] p-6">
          <div className="overflow-hidden rounded-[10px] border border-[#262a31] bg-black">
            {master ? (
              <video
                ref={videoRef}
                src={api.mediaUrl(master.path)}
                poster={rec.poster_path ? api.mediaUrl(rec.poster_path) : undefined}
                controls
                className="w-full"
                onTimeUpdate={(e) => setPosition(e.currentTarget.currentTime * 1000)}
              />
            ) : (
              <div className="flex aspect-video items-center justify-center text-[12px] text-[#6b727d]">
                No video track
              </div>
            )}
          </div>

          {activeJob && (
            <div className="rounded-[10px] border border-[#F5A524]/30 bg-[#F5A524]/5 px-3.5 py-2.5 text-[12px] text-[#F5A524]">
              {activeJob.stage ?? 'Working'} · {Math.round((activeJob.progress ?? 0) * 100)}%
            </div>
          )}

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
              variant="primary"
              onClick={() => setCutOpen(true)}
              disabled={!detail.transcript || !!activeJob}
              title={detail.transcript ? '' : 'Transcribe first — the cut is driven by what you said'}
            >
              Cut into content
            </Button>
            <Button
              size="sm"
              onClick={async () => {
                await soft(api.pipeline.notes(id), null)
                toast.push({ tone: 'info', title: 'Writing notes' })
                setTab('notebook')
              }}
              disabled={!detail.transcript || !!activeJob}
            >
              Generate notes
            </Button>
            <Button
              size="sm"
              variant="ghost"
              onClick={async () => {
                const r = await soft(api.exportBundle(id), { cancelled: true, dir: '' })
                if (!r.cancelled) {
                  toast.ok('Bundle exported', r.dir)
                  await soft(api.shell.showItem(r.dir), false)
                }
              }}
              disabled={detail.clips.length === 0}
            >
              Export bundle
            </Button>
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

        {/* --------------------------------------------------------- tabs */}
        <div className="flex min-h-0 flex-col">
          <div className="flex items-center gap-1 border-b border-[#1d2026] px-6 pt-3">
            {(['clips', 'transcript', 'notebook'] as Tab[]).map((t) => (
              <button
                key={t}
                onClick={() => setTab(t)}
                className={cls(
                  'relative px-3 pb-2.5 pt-1 text-[13px] capitalize transition-colors',
                  tab === t ? 'text-[#e9eaec]' : 'text-[#6b727d] hover:text-[#9aa1ab]'
                )}
              >
                {t}
                {t === 'clips' && detail.clips.length > 0 && (
                  <span className="mono ml-1.5 text-[11px] text-[#6b727d]">{detail.clips.length}</span>
                )}
                {tab === t && (
                  <span className="absolute inset-x-2 -bottom-px h-[2px] rounded-full bg-[#F5A524]" />
                )}
              </button>
            ))}
          </div>

          <div className="min-h-0 flex-1 overflow-y-auto p-6">
            {tab === 'clips' && (
              <ClipsTab
                detail={detail}
                rendersByClip={rendersByClip}
                onCut={() => setCutOpen(true)}
                onChanged={load}
                working={!!activeJob}
              />
            )}
            {tab === 'transcript' && (
              <TranscriptTab detail={detail} position={position} onSeek={seek} />
            )}
            {tab === 'notebook' && <NotebookTab detail={detail} onSaved={load} />}
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
    </div>
  )
}

function ClipsTab({
  detail,
  rendersByClip,
  onCut,
  onChanged,
  working
}: {
  detail: Detail
  rendersByClip: Map<string, Detail['renders'][number]>
  onCut: () => void
  onChanged: () => void
  working: boolean
}): React.ReactElement {
  if (detail.clips.length === 0) {
    if (working) return <ClipSkeleton />
    return (
      <Empty
        title="No clips yet"
        body={
          detail.transcript
            ? 'Showoff reads the transcript, finds the moments worth posting, and renders one file per platform with a caption you can edit.'
            : 'Transcribe this recording first. The cut is driven entirely by what you said.'
        }
        action={
          detail.transcript ? (
            <Button variant="primary" onClick={onCut}>
              Cut into content
            </Button>
          ) : undefined
        }
      />
    )
  }
  return (
    <div className="flex flex-col gap-3">
      {working && <ClipSkeleton />}
      {detail.clips.map((c) => (
        <ClipCard key={c.id} clip={c} render={rendersByClip.get(c.id) ?? null} onChanged={onChanged} />
      ))}
    </div>
  )
}

function TranscriptTab({
  detail,
  position,
  onSeek
}: {
  detail: Detail
  position: number
  onSeek: (ms: number) => void
}): React.ReactElement {
  if (!detail.transcript) {
    return (
      <Empty
        title="Not transcribed yet"
        body="Transcription runs locally with whisper.cpp by default — nothing leaves your machine unless you point Showoff at a cloud provider in Settings."
      />
    )
  }
  const segments = detail.transcript.segments
  if (segments.length === 0) {
    return (
      <div className="whitespace-pre-wrap text-[13px] leading-relaxed text-[#c8ccd2]">
        {detail.transcript.text}
      </div>
    )
  }
  return (
    <div className="flex flex-col">
      <div className="mb-3 text-[11.5px] text-[#6b727d]">
        {segments.length} segments · {detail.transcript.provider} · click any line to jump the video
      </div>
      {segments.map((s) => {
        const active = position >= s.start_ms && position < s.end_ms
        return (
          <button
            key={s.id}
            onClick={() => onSeek(s.start_ms)}
            className={cls(
              'flex gap-3 rounded-[8px] px-2 py-1.5 text-left transition-colors',
              active ? 'bg-[#F5A524]/10' : 'hover:bg-[#15181d]'
            )}
          >
            <span
              className={cls(
                'mono shrink-0 pt-[2px] text-[11px]',
                active ? 'text-[#F5A524]' : 'text-[#565d68]'
              )}
            >
              {fmtClock(s.start_ms)}
            </span>
            <span className={cls('text-[13px] leading-relaxed', active ? 'text-white' : 'text-[#c8ccd2]')}>
              {s.text}
            </span>
          </button>
        )
      })}
    </div>
  )
}

function NotebookTab({
  detail,
  onSaved
}: {
  detail: Detail
  onSaved: () => void
}): React.ReactElement {
  const [title, setTitle] = useState(detail.note?.title ?? detail.recording.title)
  const [body, setBody] = useState(detail.note?.body ?? '')
  const [saved, setSaved] = useState<'idle' | 'saving' | 'saved'>('idle')
  const dirty = useRef(false)

  useEffect(() => {
    setTitle(detail.note?.title ?? detail.recording.title)
    setBody(detail.note?.body ?? '')
    dirty.current = false
  }, [detail.note?.id, detail.note?.body, detail.note?.title, detail.recording.title])

  // Autosave, because a notebook you have to remember to save is a notebook
  // that loses your notes.
  useEffect(() => {
    if (!dirty.current) return
    setSaved('saving')
    const t = setTimeout(async () => {
      await soft(api.notes.save({ recordingId: detail.recording.id, title, body }), null)
      setSaved('saved')
      dirty.current = false
      onSaved()
    }, 900)
    return () => clearTimeout(t)
  }, [title, body, detail.recording.id, onSaved])

  return (
    <div className="flex h-full flex-col">
      <div className="mb-2 flex items-center gap-3">
        <input
          value={title}
          onChange={(e) => {
            dirty.current = true
            setTitle(e.target.value)
          }}
          className="min-w-0 flex-1 bg-transparent text-[15px] font-medium outline-none"
          placeholder="Note title"
        />
        <span className="mono shrink-0 text-[11px] text-[#6b727d]">
          {saved === 'saving' ? 'saving…' : saved === 'saved' ? 'saved' : ''}
        </span>
      </div>
      <textarea
        value={body}
        onChange={(e) => {
          dirty.current = true
          setBody(e.target.value)
        }}
        placeholder="Markdown. Generate notes from the transcript, then edit them into something you would actually reread."
        className="min-h-[320px] flex-1 resize-none rounded-[10px] border border-[#262a31] bg-[#0f1115] p-4 text-[13px] leading-[1.7] outline-none placeholder:text-[#565d68] focus:border-[#F5A524]/40"
      />
    </div>
  )
}
