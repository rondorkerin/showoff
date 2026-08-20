import React, { useCallback, useEffect, useRef, useState } from 'react'
import { api, must, soft } from '../lib/api.ts'
import { cls, fmtClock } from '../lib/format.ts'
import { Button } from './ui.tsx'
import { useToast } from './Toasts.tsx'

type Phase = 'idle' | 'arming' | 'recording' | 'saving'

/**
 * A second pass over footage you have already captured: the project plays
 * back from the top while you narrate it. The result is a lane like any other
 * -- you can play it, level it, move it in time, duck the original under it,
 * or delete it -- rather than a hidden track that quietly replaces what you
 * recorded and can only be undone by re-transcribing.
 */
export default function Voiceover({
  recordingId,
  hasVoiceover,
  playback,
  onSaved
}: {
  recordingId: string
  hasVoiceover: boolean
  /** Drives the editor's own transport, so you narrate to picture. */
  playback: { start: () => void; stop: () => void }
  onSaved: () => void
}): React.ReactElement {
  const toast = useToast()
  const [phase, setPhase] = useState<Phase>('idle')
  const [elapsed, setElapsed] = useState(0)
  const [level, setLevel] = useState(0)
  const recorder = useRef<MediaRecorder | null>(null)
  const stream = useRef<MediaStream | null>(null)
  const ctx = useRef<AudioContext | null>(null)
  const raf = useRef<number | null>(null)
  const timer = useRef<ReturnType<typeof setInterval> | null>(null)

  const teardown = useCallback(() => {
    stream.current?.getTracks().forEach((t) => t.stop())
    stream.current = null
    recorder.current = null
    if (raf.current != null) cancelAnimationFrame(raf.current)
    raf.current = null
    if (timer.current) clearInterval(timer.current)
    timer.current = null
    void ctx.current?.close().catch(() => undefined)
    ctx.current = null
  }, [])

  useEffect(() => () => teardown(), [teardown])

  const remove = async (): Promise<void> => {
    const res = await api.voiceover.remove(recordingId)
    if (res.ok) {
      toast.ok('Voice-over removed', 'The audio file stays on disk. Re-transcribe to use your original narration.')
      onSaved()
    } else {
      toast.fail('Could not remove the voice-over', res.error)
    }
  }

  const start = async (): Promise<void> => {
    setPhase('arming')
    try {
      const s = await navigator.mediaDevices.getUserMedia({
        audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true }
      })
      stream.current = s

      const audioCtx = new AudioContext()
      const analyser = audioCtx.createAnalyser()
      analyser.fftSize = 1024
      audioCtx.createMediaStreamSource(s).connect(analyser)
      ctx.current = audioCtx
      const buf = new Uint8Array(analyser.fftSize)
      const tick = (): void => {
        analyser.getByteTimeDomainData(buf)
        let peak = 0
        for (const v of buf) peak = Math.max(peak, Math.abs(v - 128) / 128)
        setLevel(peak)
        raf.current = requestAnimationFrame(tick)
      }
      raf.current = requestAnimationFrame(tick)

      await must(api.voiceover.start(recordingId))

      const mime = MediaRecorder.isTypeSupported('audio/webm;codecs=opus')
        ? 'audio/webm;codecs=opus'
        : 'audio/webm'
      const r = new MediaRecorder(s, { mimeType: mime, audioBitsPerSecond: 128_000 })
      r.ondataavailable = (e): void => {
        if (!e.data.size) return
        void e.data.arrayBuffer().then((b) => api.recording.chunk(recordingId, 'voiceover', b))
      }
      r.start(2000)
      recorder.current = r

      // Play the project back from the top so you are narrating to picture
      // rather than to a static frame.
      playback.start()

      const t0 = Date.now()
      timer.current = setInterval(() => setElapsed(Date.now() - t0), 250)
      setPhase('recording')
    } catch (e) {
      teardown()
      setPhase('idle')
      toast.fail('Could not start the voice-over', e)
    }
  }

  const stop = async (discard: boolean): Promise<void> => {
    setPhase('saving')
    playback.stop()

    const r = recorder.current
    if (r && r.state !== 'inactive') {
      await new Promise<void>((resolve) => {
        r.onstop = (): void => resolve()
        try {
          r.requestData()
          r.stop()
        } catch {
          resolve()
        }
      })
    }
    await new Promise((res) => setTimeout(res, 250))
    teardown()

    try {
      if (discard) {
        await soft(api.voiceover.cancel(recordingId), undefined)
      } else {
        await must(api.voiceover.finalize(recordingId))
        toast.ok('Voice-over saved', 'Re-transcribe to cut from the new narration.')
        onSaved()
      }
    } catch (e) {
      toast.fail('Could not save the voice-over', e)
    } finally {
      setPhase('idle')
      setElapsed(0)
    }
  }

  if (phase === 'idle') {
    return (
      <div className="flex items-center gap-2">
        <Button size="sm" variant="ghost" onClick={() => void start()}>
          {hasVoiceover ? 'Re-record voice-over' : 'Record voice-over'}
        </Button>
        {hasVoiceover && (
          <Button size="sm" variant="ghost" onClick={() => void remove()}>
            Remove
          </Button>
        )}
        <span className="text-[11px] text-[#6b727d]">
          {hasVoiceover
            ? 'A voice-over is attached. Re-transcribe to use it.'
            : 'Narrate over the footage instead of your live audio.'}
        </span>
      </div>
    )
  }

  return (
    <div className="flex items-center gap-3 rounded-[10px] border border-[#F5A524]/35 bg-[#F5A524]/5 px-3.5 py-2.5">
      <span
        className={cls(
          'inline-block h-[8px] w-[8px] shrink-0 rounded-full bg-[#F5A524]',
          phase === 'recording' && 'rec-dot'
        )}
      />
      <span className="mono text-[13px] text-[#F5A524]">{fmtClock(elapsed)}</span>
      <div className="flex items-end gap-[2px]">
        {Array.from({ length: 10 }, (_, i) => (
          <span
            key={i}
            className={cls(
              'w-[3px] rounded-[1px]',
              i < Math.round(Math.min(1, level * 2.2) * 10) ? 'bg-[#F5A524]' : 'bg-[#3a3020]'
            )}
            style={{ height: `${5 + i}px` }}
          />
        ))}
      </div>
      <span className="flex-1" />
      <Button size="sm" variant="primary" onClick={() => void stop(false)} disabled={phase !== 'recording'}>
        Save
      </Button>
      <Button size="sm" variant="danger" onClick={() => void stop(true)}>
        Discard
      </Button>
    </div>
  )
}
