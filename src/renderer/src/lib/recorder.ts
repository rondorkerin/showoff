import { useCallback, useEffect, useRef, useState } from 'react'
import { api, must, soft } from './api.ts'
import type { LaneKind } from '../../../shared/types.ts'

export type RecorderPhase =
  | 'idle'
  | 'arming'
  | 'countdown'
  | 'recording'
  | 'paused'
  | 'finalizing'

interface TrackRig {
  kind: LaneKind
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
  const stream = await navigator.mediaDevices.getUserMedia({
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

  await assertNotTheCamera(stream)
  return stream
}

/**
 * When Chromium cannot satisfy the desktop constraints -- screen recording not
 * granted, or a source id that has gone stale -- it does not fail. It quietly
 * hands back the default camera instead, and the recording that comes out looks
 * completely normal while being a video of your face where your screen should
 * be. That happened, and nothing caught it until someone watched the file.
 *
 * Only rejects on a positive match against a real camera, so an unfamiliar
 * desktop-capture label can never block a legitimate recording.
 */
async function assertNotTheCamera(stream: MediaStream): Promise<void> {
  const track = stream.getVideoTracks()[0]
  if (!track) return

  const settings = track.getSettings() as MediaTrackSettings & { displaySurface?: string }
  // Present only on display captures, so it settles the question outright.
  if (settings.displaySurface) return

  const cameras = await navigator.mediaDevices
    .enumerateDevices()
    .then((all) => all.filter((d) => d.kind === 'videoinput'))
    .catch(() => [])

  const looksLikeACamera = cameras.some((c) => c.label && c.label === track.label)
  if (!looksLikeACamera) return

  stream.getTracks().forEach((t) => t.stop())
  throw new Error(
    `Your camera came back instead of your screen ("${track.label}"). macOS does this when ` +
      'screen recording has not been granted to Showoff. Allow it under Privacy & Security → ' +
      'Screen & System Audio Recording, then quit and reopen Showoff.'
  )
}

export interface StartOptions {
  title: string
  projectId: string | null
  sourceId: string | null
  mic: boolean
  webcam: boolean
  /** Record what the machine is playing as its own lane. */
  system?: boolean
  micDeviceId?: string
  webcamDeviceId?: string
  countdownSeconds: number
  /** Record into an existing recording instead of starting a new one. */
  attachTo?: string | null
}

/**
 * Whatever the machine is playing, as an audio-only stream.
 *
 * Windows hands this over natively: the main process answers the display-media
 * request with `audio: 'loopback'`, so the video track that comes back with it
 * is thrown away immediately -- we already have the screen from the picker the
 * user chose in our own UI, and decoding it twice would be pure waste.
 *
 * macOS does not go through here at all when the ScreenCaptureKit sidecar is
 * available -- the main process captures that itself, because Chromium gives
 * the renderer no way to reach the system mix. This is the fallback for macOS
 * 12 and for anyone who already routes audio through a virtual device.
 * `pattern` comes from the main process rather than being hardcoded here, so
 * adding support for another device is a one-line change over there.
 */
async function systemAudioStream(pattern: string): Promise<MediaStream> {
  if (navigator.userAgent.includes('Windows')) {
    const display = await navigator.mediaDevices.getDisplayMedia({ video: true, audio: true })
    display.getVideoTracks().forEach((t) => {
      display.removeTrack(t)
      t.stop()
    })
    if (display.getAudioTracks().length === 0) {
      throw new Error('Windows returned no computer audio for that source.')
    }
    return display
  }

  const re = new RegExp(pattern, 'i')
  const devices = await navigator.mediaDevices.enumerateDevices()
  const device = devices.find((d) => d.kind === 'audioinput' && re.test(d.label))
  if (!device) {
    throw new Error(
      'No virtual audio device found. Install one from Settings, then send the audio you ' +
        'want to record into it.'
    )
  }
  return navigator.mediaDevices.getUserMedia({
    audio: {
      deviceId: { exact: device.deviceId },
      echoCancellation: false,
      noiseSuppression: false,
      autoGainControl: false
    }
  })
}

export interface RecorderState {
  phase: RecorderPhase
  recordingId: string | null
  elapsedMs: number
  countdown: number
  level: number
  error: string | null
  /** A track that could not be captured, while the rest of the take goes on. */
  warning: string | null
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
    warning: null,
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
  const attaching = useRef<string | null>(null)

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
    async (
      recordingId: string,
      opts: StartOptions,
      streams: Partial<Record<LaneKind, MediaStream>>,
      systemViaSidecar: boolean
    ) => {
      // Started before the recorders rather than alongside them: the sidecar
      // takes a moment to open its stream, and paying that cost up front keeps
      // computer audio lined up with the picture instead of trailing it.
      //
      // A failure here loses one lane, not the take. Computer audio is the one
      // track macOS can refuse on its own -- a freshly installed copy has no
      // Screen Recording grant yet -- and throwing away three good tracks over
      // it is how a recording session becomes an argument with a permissions
      // pane. The main process needs no telling: with no samples arriving the
      // system track finalizes to nothing.
      if (systemViaSidecar) {
        const res = await api.audio.beginCapture(recordingId)
        if (!res.ok) {
          setState((s) => ({ ...s, warning: res.error.message }))
        }
      }

      const made: TrackRig[] = []
      for (const [kind, stream] of Object.entries(streams) as Array<[LaneKind, MediaStream]>) {
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
      setState((s) => ({ ...s, phase: 'arming', error: null, warning: null, elapsedMs: 0 }))
      const streams: Partial<Record<LaneKind, MediaStream>> = {}
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
        let systemViaSidecar = false
        if (opts.system) {
          const status = await soft(api.audio.loopback(), null)
          if (status?.route === 'sidecar') systemViaSidecar = true
          else {
            streams.system = await systemAudioStream(
              status?.devicePattern ?? 'blackhole|loopback|virtual audio'
            )
          }
        }
        if (!streams.screen && !streams.webcam && !streams.system && !systemViaSidecar) {
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

        // 'system' is listed even with no stream behind it, so the main process
        // knows to open a sidecar track for it.
        const kinds = [
          ...(Object.keys(streams) as LaneKind[]),
          ...(systemViaSidecar ? (['system'] as LaneKind[]) : [])
        ]
        attaching.current = opts.attachTo ?? null
        const recordingId = opts.attachTo
          ? (await must(api.recording.addSource(opts.attachTo, kinds)), opts.attachTo)
          : (
              await must(
                api.recording.start({
                  title: opts.title,
                  projectId: opts.projectId,
                  kinds
                })
              )
            ).recordingId
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
        await beginTracks(recordingId, opts, streams, systemViaSidecar)
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
      await must(attaching.current ? api.recording.finalizeSource(id) : api.recording.finalize(id))
      attaching.current = null
      recordingIdRef.current = null
      setState({
        phase: 'idle',
        recordingId: null,
        elapsedMs: 0,
        countdown: 0,
        level: 0,
        error: null,
        warning: null,
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
    const wasAttaching = attaching.current
    recordingIdRef.current = null
    attaching.current = null
    if (id) await (wasAttaching ? api.recording.cancelSource(id) : api.recording.cancel(id))
    setState({
      phase: 'idle',
      recordingId: null,
      elapsedMs: 0,
      countdown: 0,
      level: 0,
      error: null,
      warning: null,
      previewScreen: null,
      previewWebcam: null,
      silentSeconds: 0
    })
  }, [teardown])

  return {
    state,
    start,
    stop,
    pause,
    resume,
    cancel,
    clearError: () => setState((s) => ({ ...s, error: null })),
    clearWarning: () => setState((s) => ({ ...s, warning: null }))
  }
}
