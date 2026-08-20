import React, { useCallback, useEffect, useState } from 'react'
import { api, must, soft } from '../lib/api.ts'
import { cls, fmtClock } from '../lib/format.ts'
import { useRecorder } from '../lib/recorder.ts'
import { Button, Modal, Spinner, Toggle } from './ui.tsx'
import { useToast } from './Toasts.tsx'
import type { CaptureSource } from '../../../preload/index.ts'
import type { LoopbackStatus } from '../../../shared/types.ts'

/**
 * Records another source into a project that already exists.
 *
 * The lane arrives at position zero and, if it is video, in the corner and on
 * top -- the shot that was already working must not be covered up by the thing
 * you just added. Where it belongs in time is a drag on the timeline, which is
 * a better answer than a form field asking you to guess in milliseconds.
 */
export default function AddSource({
  open,
  onClose,
  recordingId,
  onAdded
}: {
  open: boolean
  onClose: () => void
  recordingId: string
  onAdded: () => void
}): React.ReactElement {
  const toast = useToast()
  const [sources, setSources] = useState<CaptureSource[]>([])
  const [loading, setLoading] = useState(false)
  const [sourceId, setSourceId] = useState<string | null>(null)
  const [screen, setScreen] = useState(true)
  const [webcam, setWebcam] = useState(false)
  const [mic, setMic] = useState(false)
  const [system, setSystem] = useState(false)
  const [loopback, setLoopback] = useState<LoopbackStatus | null>(null)

  const finished = useCallback(() => {
    toast.ok('Source added', 'It is on the timeline at the start.')
    onAdded()
    onClose()
  }, [onAdded, onClose, toast])

  const rec = useRecorder(finished)

  useEffect(() => {
    if (!open) return
    setLoading(true)
    void soft(api.audio.loopback(), null).then(setLoopback)
    void must(api.sources.list())
      .then((list) => {
        setSources(list)
        setSourceId((cur) => cur ?? list.find((s) => s.kind === 'screen')?.id ?? list[0]?.id ?? null)
      })
      .catch((e) => toast.fail('Could not list screens', e))
      .finally(() => setLoading(false))
  }, [open, toast])

  const busy = rec.state.phase !== 'idle'
  const nothingPicked = !(screen && sourceId) && !webcam && !mic && !system

  return (
    <Modal
      open={open}
      onClose={busy ? () => undefined : onClose}
      title="Add a source"
      subtitle="It becomes a new lane on this project's timeline."
      wide
    >
      <div className="flex flex-col gap-4">
        {rec.state.error && (
          <div className="rounded-[8px] border border-[#f0616d]/30 bg-[#f0616d]/5 px-3 py-2 text-[12px] text-[#f0616d]">
            {rec.state.error}
          </div>
        )}

        <div className="flex flex-col gap-2">
          <Toggle label="Screen or window" checked={screen} onChange={setScreen} />
          {screen && (
            <div className="grid max-h-[210px] grid-cols-3 gap-2 overflow-y-auto rounded-[8px] border border-[#1d2026] p-2">
              {loading && (
                <div className="col-span-3 flex items-center justify-center gap-2 py-6 text-[12px] text-[#6b727d]">
                  <Spinner /> Looking for screens…
                </div>
              )}
              {sources.map((s) => (
                <button
                  key={s.id}
                  onClick={() => setSourceId(s.id)}
                  className={cls(
                    'overflow-hidden rounded-[8px] border text-left transition-colors',
                    sourceId === s.id
                      ? 'border-[#F5A524]'
                      : 'border-[#262a31] hover:border-[#3a4048]'
                  )}
                >
                  <img src={s.thumbnail} alt="" className="aspect-video w-full bg-black object-contain" />
                  <div className="truncate px-2 py-1 text-[11px] text-[#9aa1ab]">{s.name}</div>
                </button>
              ))}
            </div>
          )}
          <Toggle label="Webcam" checked={webcam} onChange={setWebcam} />
          <Toggle label="Microphone" checked={mic} onChange={setMic} />
          <Toggle
            label="Computer audio"
            checked={system}
            onChange={setSystem}
            disabled={!loopback?.available}
          />
          {loopback && !loopback.available && (
            <p className="pl-1 text-[11.5px] leading-relaxed text-[#6b727d]">
              {loopback.detail} {loopback.remedy}
            </p>
          )}
        </div>

        <div className="flex items-center gap-3">
          {rec.state.phase === 'recording' || rec.state.phase === 'paused' ? (
            <>
              <Button variant="danger" onClick={() => void rec.stop()}>
                Stop and add
              </Button>
              <Button variant="ghost" onClick={() => void rec.cancel()}>
                Discard
              </Button>
              <span className="mono text-[13px] text-[#F5A524]">{fmtClock(rec.state.elapsedMs)}</span>
            </>
          ) : rec.state.phase === 'idle' ? (
            <Button
              variant="primary"
              disabled={nothingPicked}
              onClick={() =>
                void rec.start({
                  title: '',
                  projectId: null,
                  sourceId: screen ? sourceId : null,
                  mic,
                  webcam,
                  system,
                  countdownSeconds: 0,
                  attachTo: recordingId
                })
              }
            >
              Start recording
            </Button>
          ) : (
            <span className="flex items-center gap-2 text-[13px] text-[#9aa1ab]">
              <Spinner /> {rec.state.phase}…
            </span>
          )}
          <span className="flex-1" />
          {!busy && (
            <Button variant="ghost" onClick={onClose}>
              Close
            </Button>
          )}
        </div>
      </div>
    </Modal>
  )
}
