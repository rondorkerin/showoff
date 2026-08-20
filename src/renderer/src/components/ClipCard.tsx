import React, { useEffect, useRef, useState } from 'react'
import { api, must, soft } from '../lib/api.ts'
import { cls, fmtBytes, fmtClock, fmtDuration } from '../lib/format.ts'
import { Badge, Button, Spinner, Textarea } from './ui.tsx'
import { useToast } from './Toasts.tsx'
import type { Clip, ClipRender } from '../../../shared/types.ts'
import { PLATFORMS } from '../../../shared/platforms.ts'

export default function ClipCard({
  clip,
  render,
  onChanged
}: {
  clip: Clip
  render: ClipRender | null
  onChanged: () => void
}): React.ReactElement {
  const toast = useToast()
  const spec = PLATFORMS[clip.platform]
  const [description, setDescription] = useState(clip.description)
  const [title, setTitle] = useState(clip.title)
  const [hashtags, setHashtags] = useState((clip.hashtags ?? []).join(' '))
  const [dirty, setDirty] = useState(false)
  const [saving, setSaving] = useState(false)
  const [copied, setCopied] = useState(false)
  const [playing, setPlaying] = useState(false)
  const videoRef = useRef<HTMLVideoElement>(null)

  useEffect(() => {
    setDescription(clip.description)
    setTitle(clip.title)
    setHashtags((clip.hashtags ?? []).join(' '))
    setDirty(false)
  }, [clip.id, clip.description, clip.title, clip.hashtags])

  const save = async (): Promise<void> => {
    setSaving(true)
    try {
      await must(
        api.clips.update({
          id: clip.id,
          title,
          description,
          hashtags: hashtags
            .split(/[\s,]+/)
            .map((h) => h.replace(/^#/, '').trim())
            .filter(Boolean)
        })
      )
      setDirty(false)
      onChanged()
    } catch (e) {
      toast.fail('Could not save the clip', e)
    } finally {
      setSaving(false)
    }
  }

  const copy = async (): Promise<void> => {
    // Copy what is on screen, not what is in the database: an unsaved edit that
    // silently does not make it to the clipboard is the worst possible bug here.
    const tags = hashtags
      .split(/[\s,]+/)
      .map((h) => h.replace(/^#/, '').trim())
      .filter(Boolean)
      .map((h) => `#${h}`)
      .join(' ')
    const text = tags ? `${description}\n\n${tags}` : description
    await navigator.clipboard.writeText(text)
    setCopied(true)
    setTimeout(() => setCopied(false), 1800)
  }

  const chars = description.length
  const over = chars > spec.maxChars

  return (
    <div className="overflow-hidden rounded-[10px] border border-[#262a31] bg-[#121418]">
      <div className="flex gap-4 p-4">
        <div
          className={cls(
            'relative shrink-0 overflow-hidden rounded-[8px] bg-black',
            spec.height > spec.width ? 'w-[112px]' : 'w-[200px]'
          )}
          style={{ aspectRatio: `${spec.width} / ${spec.height}` }}
        >
          {render ? (
            playing ? (
              <video
                ref={videoRef}
                src={api.mediaUrl(render.path)}
                controls
                autoPlay
                className="h-full w-full"
                onEnded={() => setPlaying(false)}
              />
            ) : (
              <button onClick={() => setPlaying(true)} className="group h-full w-full">
                {render.poster_path ? (
                  <img src={api.mediaUrl(render.poster_path)} alt="" className="h-full w-full object-cover" />
                ) : (
                  <div className="h-full w-full bg-[#191c21]" />
                )}
                <span className="absolute inset-0 flex items-center justify-center">
                  <span className="flex h-9 w-9 items-center justify-center rounded-full bg-black/60 text-[#e9eaec] group-hover:bg-black/80">
                    ▶
                  </span>
                </span>
              </button>
            )
          ) : (
            <div className="flex h-full items-center justify-center px-2 text-center text-[11px] leading-tight text-[#6b727d]">
              not rendered
            </div>
          )}
        </div>

        <div className="min-w-0 flex-1">
          <div className="mb-2 flex flex-wrap items-center gap-2">
            <Badge tone="accent">{spec.label}</Badge>
            <span className="mono text-[11px] text-[#6b727d]">
              {fmtClock(clip.start_ms)} → {fmtClock(clip.end_ms)} ·{' '}
              {fmtDuration(clip.end_ms - clip.start_ms)}
            </span>
            {render && (
              <span className="mono text-[11px] text-[#6b727d]">
                {render.width}×{render.height} · {fmtBytes(render.bytes)}
              </span>
            )}
            <span className="flex-1" />
            <span
              className="mono text-[11px] text-[#6b727d]"
              title="How strongly the model rated this moment as a standalone piece of content"
            >
              hook {Math.round((clip.score ?? 0) * 100)}
            </span>
          </div>

          <input
            value={title}
            onChange={(e) => {
              setTitle(e.target.value)
              setDirty(true)
            }}
            className="mb-2 w-full bg-transparent text-[14px] font-medium outline-none focus:text-white"
          />

          {clip.hook && (
            <div className="mb-2 border-l-2 border-[#F5A524]/50 pl-2.5 text-[12px] italic leading-relaxed text-[#9aa1ab]">
              “{clip.hook}”
            </div>
          )}

          <Textarea
            rows={4}
            value={description}
            onChange={(e) => {
              setDescription(e.target.value)
              setDirty(true)
            }}
          />

          <div className="mt-2 flex items-center gap-2">
            <input
              value={hashtags}
              onChange={(e) => {
                setHashtags(e.target.value)
                setDirty(true)
              }}
              placeholder="hashtags"
              className="mono min-w-0 flex-1 rounded-[8px] border border-[#262a31] bg-[#0f1115] px-2.5 py-1.5 text-[11.5px] text-[#9aa1ab] outline-none focus:border-[#F5A524]/60"
            />
            <span className={cls('mono shrink-0 text-[11px]', over ? 'text-[#f0616d]' : 'text-[#6b727d]')}>
              {chars}/{spec.maxChars}
            </span>
          </div>

          {clip.reason && (
            <div className="mt-2 text-[11.5px] leading-relaxed text-[#6b727d]">{clip.reason}</div>
          )}

          <div className="mt-3 flex flex-wrap items-center gap-2">
            <Button size="sm" variant={copied ? 'primary' : 'default'} onClick={() => void copy()}>
              {copied ? 'Copied' : 'Copy share text'}
            </Button>
            {dirty && (
              <Button size="sm" variant="primary" onClick={() => void save()} loading={saving}>
                Save
              </Button>
            )}
            {render && (
              <Button size="sm" variant="ghost" onClick={() => void soft(api.shell.showItem(render.path), false)}>
                Show file
              </Button>
            )}
            <Button
              size="sm"
              variant="ghost"
              onClick={async () => {
                await soft(api.clips.rerender(clip.id), null)
                toast.push({ tone: 'info', title: 'Re-rendering this clip' })
              }}
            >
              Re-render
            </Button>
            <Button
              size="sm"
              variant="danger"
              onClick={async () => {
                await soft(api.clips.remove(clip.id), undefined)
                onChanged()
              }}
            >
              Delete
            </Button>
          </div>
        </div>
      </div>
    </div>
  )
}

export function ClipSkeleton(): React.ReactElement {
  return (
    <div className="flex items-center gap-3 rounded-[10px] border border-dashed border-[#262a31] px-4 py-6 text-[12.5px] text-[#9aa1ab]">
      <Spinner /> Rendering clips — this runs ffmpeg once per clip, so it takes a minute.
    </div>
  )
}
