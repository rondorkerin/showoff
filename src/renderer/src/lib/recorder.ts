import { useCallback, useEffect, useRef, useState } from 'react'
import { api, must } from './api.ts'
import type { TrackKind } from '../../../shared/types.ts'

export type RecorderPhase =
  | 'idle'
  | 'arming'
  | 'countdown'
  | 'recording'
  | 'paused'
  | 'finalizing'

interface TrackRig {
  kind: TrackKind
  stream: MediaStream
  recorder: MediaRecorder
}

const CHUNK_MS = 2000

function pickMime(video: boolean): string {
  const candidates = video
    ? ['video/webm;codecs=vp9,opus', 'video/webm;codecs=vp8,opus', 'video/webm']
    : ['audio/webm;codecs=opus', 'audio/webm']
  for (const c of candidates) {
    if (MediaRecorder.isTypeSupported(c)) return c
  }
  return video ? 'video/webm' : 'audio/webm'
}

async function screenStream(sourceId: string): Promise<MediaStream> {
  // Electron's desktopCapturer id is handed to getUserMedia through the legacy
  // chromeMediaSource constraints; getDisplayMedia would re-prompt the OS picker
  // and lose the source the user already chose in our own UI.
  return await navigator.mediaDevices.getUserMedia({
    audio: false,
    video: {
      mandatory: {
        chromeMediaSource: 'desktop',
        chromeMediaSourceId: sourceId,
        maxFrameRate: 30,
        maxWidth: 2560,
        maxHeight: 1440
      }
    }
  } as unknown as MediaStreamConstraints)
}

export interface StartOptions {
  title: string
  projectId: string | null
  sourceId: string | null
  mic: boolean
  webcam: boolean
  micDeviceId?: string
  webcamDeviceId?: string
  countdownSeconds: number
}

export interface RecorderState {
  phase: RecorderPhase
  recordingId: string | null
  elapsedMs: number
  countdown: number
  level: number
  error: string | null
  previewScreen: MediaStream | null
  previewWebcam: MediaStream | null
  silentSeconds: number
}

export function useRecorder(onFinalized: (recordingId: string) => void) {
  const [state, setState] = useState<RecorderState>({
    phase: 'idle',
    recordingId: null,
    elapsedMs: 0,
    countdown: 0,
    level: 0,
    error: null,
    previewScreen: null,
    previewWebcam: null,
    silentSeconds: 0
  })

  const rigs = useRef<TrackRig[]>([])
  const audioCtx = useRef<AudioContext | null>(null)
  const analyser = useRef<AnalyserNode | null>(null)
  const raf = useRef<number | null>(null)
  const timer = useRef<ReturnType<typeof setInterval> | null>(null)
  const startedAt = useRef(0)
  const pausedFor = useRef(0)
  const pausedAt = useRef(0)
  const quietSince = useRef<number | null>(null)
  const recordingIdRef = useRef<string | null>(null)

  const teardown = useCallback(() => {
    for (const rig of rigs.current) {
      try {
        if (rig.recorder.state !== 'inactive') rig.recorder.stop()
      } catch {
        /* already stopped */
      }
      rig.stream.getTracks().forEach((t) => t.stop())
    }
    rigs.current = []
    if (raf.current != null) cancelAnimationFrame(raf.current)
    raf.current = null
    if (timer.current) clearInterval(timer.current)
    timer.current = null
    void audioCtx.current?.close().catch(() => undefined)
    audioCtx.current = null
    analyser.current = null
    quietSince.current = null
  }, [])

  useEffect(() => () => teardown(), [teardown])

  /** Drives the level meter and the "you have been silent" hint. */
  const meter = useCallback(() => {
    const node = analyser.current
    if (!node) return
    const buf = new Uint8Array(node.fftSize)
    const tick = (): void => {
      node.getByteTimeDomainData(buf)
      let peak = 0
      for (const v of buf) peak = Math.max(peak, Math.abs(v - 128) / 128)
      const now = Date.now()
      if (peak > 0.02) quietSince.current = null
      else if (quietSince.current == null) quietSince.current = now
      setState((s) => ({
        ...s,
        level: peak,
        silentSeconds: quietSince.current ? Math.floor((now - quietSince.current) / 1000) : 0
      }))
      raf.current = requestAnimationFrame(tick)
    }
    raf.current = requestAnimationFrame(tick)
  }, [])

  const beginTracks = useCallback(
    async (recordingId: string, opts: StartOptions, streams: Partial<Record<TrackKind, MediaStream>>) => {
      const made: TrackRig[] = []
      for (const [kind, stream] of Object.entries(streams) as Array<[TrackKind, MediaStream]>) {
        const isVideo = stream.getVideoTracks().length > 0
        const recorder = new MediaRecorder(stream, {
          mimeType: pickMime(isVideo),
          videoBitsPerSecond: kind === 'webcam' ? 2_000_000 : 6_000_000,
          audioBitsPerSecond: 128_000
        })
        recorder.ondataavailable = (e): void => {
          if (e.data.size === 0) return
          void e.data.arrayBuffer().then((buf) => {
            const id = recordingIdRef.current
            if (id) api.recording.chunk(id, kind, buf)
          })
        }
        recorder.onerror = (e): void => {
          setState((s) => ({ ...s, error: `Recorder for ${kind} failed: ${String(e)}` }))
        }
        recorder.start(CHUNK_MS)
        made.push({ kind, stream, recorder })
      }
      rigs.current = made

      startedAt.current = Date.now()
      pausedFor.current = 0
      timer.current = setInterval(() => {
        setState((s) =>
          s.phase === 'recording'
            ? { ...s, elapsedMs: Date.now() - startedAt.current - pausedFor.current }
            : s
        )
      }, 250)

      setState((s) => ({ ...s, phase: 'recording', recordingId, countdown: 0 }))
    },
    []
  )

  const start = useCallback(
    async (opts: StartOptions) => {
      setState((s) => ({ ...s, phase: 'arming', error: null, elapsedMs: 0 }))
      const streams: Partial<Record<TrackKind, MediaStream>> = {}
      try {
        if (opts.sourceId) streams.screen = await screenStream(opts.sourceId)
        if (opts.mic) {
          streams.mic = await navigator.mediaDevices.getUserMedia({
            audio: {
              deviceId: opts.micDeviceId ? { exact: opts.micDeviceId } : undefined,
              echoCancellation: true,
              noiseSuppression: true,
              autoGainControl: true
            }
          })
        }
        if (opts.webcam) {
          streams.webcam = await navigator.mediaDevices.getUserMedia({
            video: {
              deviceId: opts.webcamDeviceId ? { exact: opts.webcamDeviceId } : undefined,
              width: { ideal: 1280 },
              height: { ideal: 720 },
              frameRate: { ideal: 30 }
            }
          })
        }
        if (!streams.screen && !streams.webcam) {
          throw new Error('Pick a screen, a window, or your webcam before recording.')
        }

        if (streams.mic) {
          const ctx = new AudioContext()
          const node = ctx.createAnalyser()
          node.fftSize = 1024
          ctx.createMediaStreamSource(streams.mic).connect(node)
          audioCtx.current = ctx
          analyser.current = node
          meter()
        }

        const { recordingId } = await must(
          api.recording.start({
            title: opts.title,
            projectId: opts.projectId,
            kinds: Object.keys(streams) as TrackKind[]
          })
        )
        recordingIdRef.current = recordingId

        setState((s) => ({
          ...s,
          previewScreen: streams.screen ?? null,
          previewWebcam: streams.webcam ?? null,
          recordingId
        }))

        // A countdown is not decoration: it is the difference between a clean
        // opening line and three seconds of you reaching for the mouse.
        if (opts.countdownSeconds > 0) {
          setState((s) => ({ ...s, phase: 'countdown', countdown: opts.countdownSeconds }))
          for (let n = opts.countdownSeconds; n > 0; n--) {
            setState((s) => ({ ...s, countdown: n }))
            await new Promise((r) => setTimeout(r, 1000))
          }
        }
        await beginTracks(recordingId, opts, streams)
      } catch (e) {
        Object.values(streams).forEach((s) => s.getTracks().forEach((t) => t.stop()))
        teardown()
        recordingIdRef.current = null
        setState((s) => ({
          ...s,
          phase: 'idle',
          recordingId: null,
          previewScreen: null,
          previewWebcam: null,
          error: e instanceof Error ? e.message : String(e)
        }))
      }
    },
    [beginTracks, meter, teardown]
  )

  const pause = useCallback(() => {
    rigs.current.forEach((r) => r.recorder.state === 'recording' && r.recorder.pause())
    pausedAt.current = Date.now()
    setState((s) => ({ ...s, phase: 'paused' }))
  }, [])

  const resume = useCallback(() => {
    rigs.current.forEach((r) => r.recorder.state === 'paused' && r.recorder.resume())
    pausedFor.current += Date.now() - pausedAt.current
    setState((s) => ({ ...s, phase: 'recording' }))
  }, [])

  const stop = useCallback(async () => {
    const id = recordingIdRef.current
    if (!id) return
    setState((s) => ({ ...s, phase: 'finalizing' }))

    // Flush whatever is buffered before the streams die, otherwise the last
    // couple of seconds — usually the sign-off — never reach disk.
    await Promise.all(
      rigs.current.map(
        (rig) =>
          new Promise<void>((resolve) => {
            if (rig.recorder.state === 'inactive') return resolve()
            rig.recorder.onstop = (): void => resolve()
            try {
              rig.recorder.requestData()
              rig.recorder.stop()
            } catch {
              resolve()
            }
          })
      )
    )
    await new Promise((r) => setTimeout(r, 250))
    teardown()

    try {
      await must(api.recording.finalize(id))
      recordingIdRef.current = null
      setState({
        phase: 'idle',
        recordingId: null,
        elapsedMs: 0,
        countdown: 0,
        level: 0,
        error: null,
        previewScreen: null,
        previewWebcam: null,
        silentSeconds: 0
      })
      onFinalized(id)
    } catch (e) {
      recordingIdRef.current = null
      setState((s) => ({
        ...s,
        phase: 'idle',
        previewScreen: null,
        previewWebcam: null,
        error: e instanceof Error ? e.message : String(e)
      }))
    }
  }, [onFinalized, teardown])

  const cancel = useCallback(async () => {
    const id = recordingIdRef.current
    rigs.current.forEach((r) => {
      try {
        if (r.recorder.state !== 'inactive') r.recorder.stop()
      } catch {
        /* noop */
      }
    })
    teardown()
    recordingIdRef.current = null
    if (id) await api.recording.cancel(id)
    setState({
      phase: 'idle',
      recordingId: null,
      elapsedMs: 0,
      countdown: 0,
      level: 0,
      error: null,
      previewScreen: null,
      previewWebcam: null,
      silentSeconds: 0
    })
  }, [teardown])

  return { state, start, stop, pause, resume, cancel, clearError: () => setState((s) => ({ ...s, error: null })) }
}
