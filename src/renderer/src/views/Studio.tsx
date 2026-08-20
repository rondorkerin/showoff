import React, { useCallback, useEffect, useRef, useState } from 'react'
import { api, must, soft } from '../lib/api.ts'
import { cls, fmtClock } from '../lib/format.ts'
import { useRecorder } from '../lib/recorder.ts'
import { Badge, Button, Card, Empty, Field, Input, Select, Spinner } from '../components/ui.tsx'
import { useToast } from '../components/Toasts.tsx'
import type { Shell } from '../App.tsx'
import type { CaptureSource } from '../../../preload/index.ts'
import type { LoopbackStatus } from '../../../shared/types.ts'

function Meter({ level }: { level: number }): React.ReactElement {
  const bars = 14
  const lit = Math.round(Math.min(1, level * 2.2) * bars)
  return (
    <div className="flex items-end gap-[2px]" aria-label="Microphone level">
      {Array.from({ length: bars }, (_, i) => (
        <span
          key={i}
          className={cls(
            'w-[3px] rounded-[1px] transition-colors',
            i < lit ? (i > bars - 3 ? 'bg-[#f0616d]' : 'bg-[#F5A524]') : 'bg-[#2a2f37]'
          )}
          style={{ height: `${6 + i * 1.1}px` }}
        />
      ))}
    </div>
  )
}

function Preview({ stream, className }: { stream: MediaStream | null; className?: string }) {
  const ref = useRef<HTMLVideoElement>(null)
  useEffect(() => {
    if (ref.current) ref.current.srcObject = stream
  }, [stream])
  if (!stream) return null
  return <video ref={ref} autoPlay muted playsInline className={className} />
}

export default function Studio({ shell }: { shell: Shell }): React.ReactElement {
  const toast = useToast()
  const [sources, setSources] = useState<CaptureSource[]>([])
  const [loadingSources, setLoadingSources] = useState(true)
  const [askedForScreen, setAskedForScreen] = useState(false)
  const [sourceId, setSourceId] = useState<string | null>(null)
  const [title, setTitle] = useState('')
  const [projectId, setProjectId] = useState<string | null>(null)
  const [mic, setMic] = useState(true)
  const [webcam, setWebcam] = useState(false)
  const [system, setSystem] = useState(false)
  const [loopback, setLoopback] = useState<LoopbackStatus | null>(null)
  const [micDevices, setMicDevices] = useState<MediaDeviceInfo[]>([])
  const [camDevices, setCamDevices] = useState<MediaDeviceInfo[]>([])
  const [micDeviceId, setMicDeviceId] = useState<string>('')
  const [camDeviceId, setCamDeviceId] = useState<string>('')
  const [countdown, setCountdown] = useState(3)
  const [hidden, setHidden] = useState(false)
  const [perms, setPerms] = useState<{ screen: string; microphone: string; camera: string } | null>(
    null
  )

  const onFinalized = useCallback(
    (id: string) => {
      shell.setRecording(false)
      toast.ok('Recording saved', 'Transcribing it now.')
      void api.pipeline.transcribe(id)
      shell.go({ name: 'recording', id })
    },
    [shell, toast]
  )

  const rec = useRecorder(onFinalized)

  const loadSources = useCallback(async () => {
    setLoadingSources(true)
    setPerms(await soft(api.permissions.status(), null))
    setLoopback(await soft(api.audio.loopback(), null))
    try {
      const list = await must(api.sources.list())
      setSources(list)
      setSourceId((cur) => cur ?? list.find((s) => s.kind === 'screen')?.id ?? list[0]?.id ?? null)
    } catch (e) {
      toast.fail('Could not list screens', e)
    } finally {
      setLoadingSources(false)
    }
  }, [toast])

  useEffect(() => {
    void loadSources()
  }, [loadSources])

  /**
   * macOS shows the screen-recording prompt on the first capture attempt and
   * never again. If asking changed nothing, the question has already been
   * answered and only System Settings can undo it.
   */
  const askForScreen = useCallback(async () => {
    const granted = await soft(api.permissions.ask('screen'), false)
    setAskedForScreen(true)
    if (granted) {
      await loadSources()
    } else {
      toast.push({
        tone: 'info',
        title: 'macOS did not grant screen recording',
        body: 'Turn Showoff on under Privacy & Security → Screen & System Audio Recording, then quit and reopen Showoff.'
      })
    }
  }, [loadSources, toast])

  // Device labels are blank until a permission has been granted once, so the
  // list is refreshed after any getUserMedia call rather than only at mount.
  const loadDevices = useCallback(async () => {
    try {
      const all = await navigator.mediaDevices.enumerateDevices()
      setMicDevices(all.filter((d) => d.kind === 'audioinput'))
      setCamDevices(all.filter((d) => d.kind === 'videoinput'))
    } catch {
      /* enumerating is best effort */
    }
  }, [])

  useEffect(() => {
    void loadDevices()
    navigator.mediaDevices.addEventListener('devicechange', loadDevices)
    return () => navigator.mediaDevices.removeEventListener('devicechange', loadDevices)
  }, [loadDevices])

  useEffect(() => {
    if (rec.state.phase === 'recording') void loadDevices()
  }, [rec.state.phase, loadDevices])

  useEffect(() => {
    shell.setRecording(rec.state.phase === 'recording' || rec.state.phase === 'countdown')
  }, [rec.state.phase, shell])

  useEffect(() => {
    if (rec.state.error) {
      toast.push({ tone: 'bad', title: 'Recording problem', body: rec.state.error })
      rec.clearError()
    }
  }, [rec, toast])

  const busy = rec.state.phase !== 'idle'

  const start = (): void => {
    void rec.start({
      title,
      projectId,
      sourceId,
      mic,
      webcam,
      system,
      micDeviceId: micDeviceId || undefined,
      webcamDeviceId: camDeviceId || undefined,
      countdownSeconds: countdown
    })
  }

  const toggleHidden = async (): Promise<void> => {
    const next = !hidden
    setHidden(next)
    await soft(api.setAlwaysOnTop(next), false)
  }

  /* --------------------------------------------------------------- capture */

  if (rec.state.phase !== 'idle') {
    return (
      <div className="flex h-full flex-col">
        <div className="drag-region h-[38px]" />
        <div className="flex flex-1 items-center justify-center px-8 pb-8">
          <div className="w-full max-w-2xl">
            <Card className="overflow-hidden">
              <div className="relative aspect-video bg-black">
                <Preview stream={rec.state.previewScreen} className="h-full w-full object-contain" />
                {rec.state.previewWebcam && (
                  <div className="absolute bottom-3 right-3 w-[22%] overflow-hidden rounded-[8px] border border-white/15 shadow-lg">
                    <Preview stream={rec.state.previewWebcam} className="w-full" />
                  </div>
                )}
                {rec.state.phase === 'countdown' && (
                  <div className="absolute inset-0 flex items-center justify-center bg-black/70">
                    <span className="mono text-[96px] font-light text-[#F5A524]">
                      {rec.state.countdown}
                    </span>
                  </div>
                )}
                {rec.state.phase === 'arming' && (
                  <div className="absolute inset-0 flex items-center justify-center gap-3 bg-black/70 text-[13px] text-[#9aa1ab]">
                    <Spinner /> Asking for screen and microphone access…
                  </div>
                )}
                {rec.state.phase === 'finalizing' && (
                  <div className="absolute inset-0 flex items-center justify-center gap-3 bg-black/75 text-[13px] text-[#9aa1ab]">
                    <Spinner /> Writing the file…
                  </div>
                )}
              </div>

              <div className="flex items-center gap-4 px-4 py-3.5">
                <div className="flex items-center gap-2">
                  <span
                    className={cls(
                      'inline-block h-[9px] w-[9px] rounded-full bg-[#F5A524]',
                      rec.state.phase === 'recording' && 'rec-dot'
                    )}
                  />
                  <span className="mono text-[18px] tabular-nums">
                    {fmtClock(rec.state.elapsedMs)}
                  </span>
                </div>

                {mic && <Meter level={rec.state.level} />}

                <div className="flex-1" />

                {rec.state.phase === 'recording' && (
                  <Button size="sm" onClick={rec.pause}>
                    Pause
                  </Button>
                )}
                {rec.state.phase === 'paused' && (
                  <Button size="sm" onClick={rec.resume}>
                    Resume
                  </Button>
                )}
                <Button
                  size="sm"
                  variant="primary"
                  onClick={() => void rec.stop()}
                  disabled={rec.state.phase === 'finalizing' || rec.state.phase === 'arming'}
                >
                  Stop &amp; save
                </Button>
                <Button size="sm" variant="danger" onClick={() => void rec.cancel()}>
                  Discard
                </Button>
              </div>
            </Card>

            <div className="mt-3 flex items-center justify-between gap-3">
              <div className="text-[12px] text-[#6b727d]">
                {mic && rec.state.silentSeconds > 12 ? (
                  <span className="text-[#F5A524]">
                    No sound from your microphone for {rec.state.silentSeconds}s — is it muted?
                  </span>
                ) : (
                  'Chunks are written to disk as you record, so a crash still leaves a playable file.'
                )}
              </div>
              <Button size="sm" variant="ghost" onClick={() => void toggleHidden()}>
                {hidden ? 'Unpin window' : 'Keep window on top'}
              </Button>
            </div>
          </div>
        </div>
      </div>
    )
  }

  /* ------------------------------------------------------------------ idle */

  const screens = sources.filter((s) => s.kind === 'screen')
  const windows = sources.filter((s) => s.kind === 'window')

  return (
    <div className="flex h-full flex-col overflow-y-auto">
      <header className="drag-region flex items-center justify-between px-8 pb-4 pt-[34px]">
        <div>
          <h1 className="text-[18px] font-semibold tracking-tight">Studio</h1>
          <p className="mt-0.5 text-[12.5px] text-[#9aa1ab]">
            One screen share a day. Showoff turns it into everything else.
          </p>
        </div>
        <Button className="no-drag" size="sm" variant="ghost" onClick={() => void loadSources()}>
          Refresh sources
        </Button>
      </header>

      <div className="grid flex-1 grid-cols-[1fr_300px] gap-6 px-8 pb-8">
        <div className="min-w-0">
          {loadingSources ? (
            <div className="flex items-center gap-2 py-16 text-[13px] text-[#9aa1ab]">
              <Spinner /> Looking for screens and windows…
            </div>
          ) : sources.length === 0 ? (
            <Empty
              title={
                perms && perms.screen !== 'granted'
                  ? 'Showoff needs permission to see your screen'
                  : 'No screens available'
              }
              body={
                perms && perms.screen !== 'granted'
                  ? askedForScreen
                    ? 'macOS has already been asked, and it will not raise the prompt a second time. Turn Showoff on under Screen & System Audio Recording, then quit and reopen Showoff — macOS only picks the change up on a fresh launch.'
                    : 'macOS keeps screen capture behind a system permission. Ask for it and macOS will show the prompt, unless it has been answered before — in which case the switch has to be flipped in System Settings.'
                  : 'No displays or windows came back. This is usually a permission that was granted to a different copy of the app.'
              }
              action={
                <div className="flex gap-2">
                  {perms && perms.screen !== 'granted' && !askedForScreen && (
                    <Button variant="primary" onClick={() => void askForScreen()}>
                      Allow screen recording
                    </Button>
                  )}
                  <Button
                    variant={askedForScreen ? 'primary' : 'default'}
                    onClick={() => void api.permissions.open('screen')}
                  >
                    Open System Settings
                  </Button>
                  <Button onClick={() => void loadSources()}>Try again</Button>
                </div>
              }
            />
          ) : (
            <>
              <SourceGrid
                label="Screens"
                sources={screens}
                selected={sourceId}
                onSelect={setSourceId}
              />
              {windows.length > 0 && (
                <SourceGrid
                  label="Windows"
                  sources={windows}
                  selected={sourceId}
                  onSelect={setSourceId}
                  className="mt-6"
                />
              )}
            </>
          )}
        </div>

        <div className="flex flex-col gap-4">
          <Card className="p-4">
            <div className="flex flex-col gap-3.5">
              <Field label="What are you showing?">
                <Input
                  value={title}
                  onChange={(e) => setTitle(e.target.value)}
                  placeholder="Shipped the new job queue"
                />
              </Field>
              <Field label="Project">
                <Select
                  value={projectId ?? ''}
                  onChange={(e) => setProjectId(e.target.value || null)}
                >
                  <option value="">No project</option>
                  {shell.projects.map((p) => (
                    <option key={p.id} value={p.id}>
                      {p.name}
                    </option>
                  ))}
                </Select>
              </Field>
            </div>
          </Card>

          <Card className="p-4">
            <div className="mb-3 text-[12px] font-medium text-[#9aa1ab]">Tracks</div>

            <TrackRow
              on={mic}
              onToggle={(v) => {
                setMic(v)
                if (v) void api.permissions.ask('microphone')
              }}
              label="Microphone"
              devices={micDevices}
              deviceId={micDeviceId}
              onDevice={setMicDeviceId}
            />
            <TrackRow
              on={webcam}
              onToggle={(v) => {
                setWebcam(v)
                if (v) void api.permissions.ask('camera')
              }}
              label="Webcam"
              devices={camDevices}
              deviceId={camDeviceId}
              onDevice={setCamDeviceId}
              className="mt-2"
            />

            <TrackRow
              on={system}
              onToggle={setSystem}
              label="Computer audio"
              devices={[]}
              deviceId=""
              onDevice={() => undefined}
              disabled={!loopback?.available}
              className="mt-2"
            />
            {loopback && !loopback.available && (
              <p className="mt-1.5 pl-[40px] text-[11px] leading-relaxed text-[#6b727d]">
                {loopback.detail}{' '}
                {loopback.installable ? (
                  <button
                    onClick={async () => {
                      const job = await soft(api.audio.installLoopback(), null)
                      if (job) toast.push({ tone: 'info', title: 'Installing BlackHole' })
                    }}
                    className="text-[#F5A524] underline underline-offset-2"
                  >
                    Install it
                  </button>
                ) : (
                  loopback.remedy
                )}
              </p>
            )}

            <div className="mt-4">
              <Field label="Countdown">
                <Select value={countdown} onChange={(e) => setCountdown(Number(e.target.value))}>
                  <option value={0}>None</option>
                  <option value={3}>3 seconds</option>
                  <option value={5}>5 seconds</option>
                </Select>
              </Field>
            </div>
          </Card>

          <Button
            variant="primary"
            className="h-11 text-[14px]"
            onClick={start}
            disabled={busy || (!sourceId && !webcam)}
          >
            <span className="inline-block h-[9px] w-[9px] rounded-full bg-[#1A1206]" />
            Start recording
          </Button>

          {perms && ((mic && perms.microphone === 'denied') || (webcam && perms.camera === 'denied')) ? (
            <button
              onClick={() =>
                void api.permissions.open(
                  mic && perms.microphone === 'denied' ? 'microphone' : 'camera'
                )
              }
              className="rounded-[10px] border border-[#F5A524]/35 bg-[#F5A524]/8 px-3 py-2 text-left text-[11.5px] leading-relaxed text-[#F5A524]"
            >
              {mic && perms.microphone === 'denied'
                ? 'Microphone access is denied, so this recording would be silent.'
                : 'Camera access is denied, so the webcam track would be empty.'}{' '}
              Open System Settings →
            </button>
          ) : (
            <div className="text-[11.5px] leading-relaxed text-[#6b727d]">
              Every source becomes its own lane, so afterwards you can move your face around,
              change the levels or drop a track entirely without re-recording anything.
            </div>
          )}
        </div>
      </div>
    </div>
  )
}

function SourceGrid({
  label,
  sources,
  selected,
  onSelect,
  className
}: {
  label: string
  sources: CaptureSource[]
  selected: string | null
  onSelect: (id: string) => void
  className?: string
}): React.ReactElement {
  return (
    <div className={className}>
      <div className="mb-2.5 text-[12px] font-medium text-[#9aa1ab]">{label}</div>
      <div className="grid grid-cols-[repeat(auto-fill,minmax(210px,1fr))] gap-3">
        {sources.map((s) => (
          <button
            key={s.id}
            onClick={() => onSelect(s.id)}
            className={cls(
              'group overflow-hidden rounded-[10px] border text-left transition-colors',
              selected === s.id
                ? 'border-[#F5A524] bg-[#191c21]'
                : 'border-[#262a31] bg-[#121418] hover:border-[#3a4048]'
            )}
          >
            <div className="aspect-video bg-black">
              {s.thumbnail ? (
                <img src={s.thumbnail} alt="" className="h-full w-full object-contain" />
              ) : (
                <div className="flex h-full items-center justify-center text-[11px] text-[#6b727d]">
                  no preview
                </div>
              )}
            </div>
            <div className="flex items-center gap-2 px-2.5 py-2">
              <span className="min-w-0 flex-1 truncate text-[12px]">{s.name}</span>
              {selected === s.id && <Badge tone="accent">selected</Badge>}
            </div>
          </button>
        ))}
      </div>
    </div>
  )
}

function TrackRow({
  on,
  onToggle,
  label,
  devices,
  deviceId,
  onDevice,
  disabled,
  className
}: {
  on: boolean
  onToggle: (v: boolean) => void
  label: string
  devices: MediaDeviceInfo[]
  deviceId: string
  onDevice: (v: string) => void
  disabled?: boolean
  className?: string
}): React.ReactElement {
  return (
    <div className={className}>
      <button
        onClick={() => onToggle(!on)}
        role="switch"
        aria-checked={on}
        disabled={disabled}
        className={cls(
          'flex w-full items-center gap-2.5 rounded-[8px] px-1 py-1.5 text-left',
          disabled ? 'cursor-not-allowed opacity-45' : 'hover:bg-[#171a1f]'
        )}
      >
        <span
          className={cls(
            'flex h-[18px] w-[30px] shrink-0 items-center rounded-full border p-[2px] transition-colors',
            on ? 'border-[#F5A524] bg-[#F5A524]/25' : 'border-[#333944] bg-[#191c21]'
          )}
        >
          <span
            className={cls(
              'h-[12px] w-[12px] rounded-full transition-transform',
              on ? 'translate-x-[12px] bg-[#F5A524]' : 'bg-[#6b727d]'
            )}
          />
        </span>
        <span className="text-[13px]">{label}</span>
      </button>
      {on && devices.length > 0 && (
        <div className="mt-1.5 pl-[40px]">
          <Select value={deviceId} onChange={(e) => onDevice(e.target.value)} className="py-1.5 text-[12px]">
            <option value="">Default</option>
            {devices.map((d) => (
              <option key={d.deviceId} value={d.deviceId}>
                {d.label || 'Unnamed device'}
              </option>
            ))}
          </Select>
        </div>
      )}
    </div>
  )
}
