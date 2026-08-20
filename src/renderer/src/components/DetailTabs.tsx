import React, { useEffect, useRef, useState } from 'react'
import { api, soft } from '../lib/api.ts'
import { cls, fmtClock } from '../lib/format.ts'
import { Button, Empty } from './ui.tsx'
import ClipCard, { ClipSkeleton } from './ClipCard.tsx'
import type { RecordingDetail as Detail } from '../../../preload/index.ts'

export function ClipsTab({
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

export function TranscriptTab({
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

export function NotebookTab({
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
