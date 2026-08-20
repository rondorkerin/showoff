import React, { useCallback, useEffect, useState } from 'react'
import { api, soft } from '../lib/api.ts'
import { cls } from '../lib/format.ts'
import { Badge, Button, Card, Field, Input, Select, Spinner, Textarea, Toggle } from '../components/ui.tsx'
import { useToast } from '../components/Toasts.tsx'
import { PLATFORMS, PLATFORM_IDS, type PlatformId } from '../../../shared/platforms.ts'
import type { Shell } from '../App.tsx'
import type { AppSettings, Diagnostics, ProviderStatus } from '../../../shared/types.ts'

type Section = 'providers' | 'output' | 'prompts' | 'storage'

export default function Settings({ shell }: { shell: Shell }): React.ReactElement {
  const toast = useToast()
  const [section, setSection] = useState<Section>('providers')
  const [diag, setDiag] = useState<Diagnostics | null>(null)
  const [checking, setChecking] = useState(true)
  const [info, setInfo] = useState<{ version: string; platform: string; logPath: string } | null>(null)
  const [sttRoute, setSttRoute] = useState<'download' | 'homebrew' | null>(null)
  const [installing, setInstalling] = useState<string | null>(null)
  const s = shell.settings
  // The local provider reports itself unavailable both when nothing is
  // installed and when nothing can be, so the panel below reads the route to
  // decide what to offer.
  const whisperMissing = (diag?.stt ?? []).some((p) => p.id === 'whisper-cpp' && !p.available)

  const check = useCallback(async () => {
    setChecking(true)
    setDiag(await soft(api.diagnostics(), null))
    setChecking(false)
  }, [])

  useEffect(() => {
    void check()
    void soft(api.appInfo(), null).then((i) => i && setInfo(i))
    void soft(api.stt.installRoute(), null).then(setSttRoute)
  }, [check])

  useEffect(() => api.stt.onInstallProgress(({ note }) => setInstalling(note)), [])

  const installWhisper = useCallback(async () => {
    setInstalling('Starting')
    const res = await api.stt.install()
    setInstalling(null)
    if (res.ok) {
      toast.ok('Whisper installed', res.data.bin)
      void check()
    } else {
      toast.fail('Could not install Whisper', res.error)
    }
  }, [check, toast])

  if (!s) {
    return (
      <div className="flex h-full items-center justify-center gap-2 text-[13px] text-[#9aa1ab]">
        <Spinner /> Loading settings…
      </div>
    )
  }

  const set = (patch: Partial<AppSettings>): void => void shell.saveSettings(patch)

  return (
    <div className="flex h-full flex-col">
      <header className="drag-region px-8 pb-4 pt-[34px]">
        <h1 className="text-[18px] font-semibold tracking-tight">Settings</h1>
        <p className="mt-0.5 text-[12.5px] text-[#9aa1ab]">
          Showoff picks the cheapest thing that already works. Everything here is an override.
        </p>
      </header>

      <div className="flex min-h-0 flex-1">
        <nav className="w-[168px] shrink-0 px-4">
          {(
            [
              ['providers', 'Models'],
              ['output', 'Output'],
              ['prompts', 'Prompts'],
              ['storage', 'Storage']
            ] as Array<[Section, string]>
          ).map(([k, label]) => (
            <button
              key={k}
              onClick={() => setSection(k)}
              className={cls(
                'mb-0.5 block w-full rounded-[8px] px-3 py-1.5 text-left text-[13px]',
                section === k ? 'bg-[#191c21] text-[#e9eaec]' : 'text-[#9aa1ab] hover:bg-[#15181d]'
              )}
            >
              {label}
            </button>
          ))}
        </nav>

        <div className="min-w-0 flex-1 overflow-y-auto px-8 pb-10">
          {section === 'providers' && (
            <div className="flex max-w-2xl flex-col gap-5">
              <Card className="p-4">
                <div className="mb-3 flex items-center justify-between">
                  <div>
                    <div className="text-[13px] font-medium">What Showoff found</div>
                    <div className="mt-0.5 text-[11.5px] text-[#6b727d]">
                      Auto mode uses the first available provider in each list.
                    </div>
                  </div>
                  <Button size="sm" variant="ghost" onClick={() => void check()} loading={checking}>
                    Re-check
                  </Button>
                </div>
                {diag ? (
                  <div className="flex flex-col gap-3">
                    <StatusList label="Writing" items={diag.llm} />
                    <StatusList label="Transcription" items={diag.stt} />
                    <StatusList label="Under the hood" items={[...diag.binaries, diag.db]} />
                  </div>
                ) : (
                  <div className="flex items-center gap-2 py-4 text-[12.5px] text-[#9aa1ab]">
                    <Spinner /> Checking…
                  </div>
                )}
              </Card>

              <Card className="flex flex-col gap-4 p-4">
                <Field
                  label="Writing model"
                  hint="Auto tries the Claude CLI first (no API key needed if you already use Claude Code), then Anthropic, OpenAI, Ollama, then any OpenAI-compatible endpoint."
                >
                  <Select value={s.llmProvider} onChange={(e) => set({ llmProvider: e.target.value })}>
                    <option value="auto">Auto</option>
                    <option value="claude-cli">Claude CLI</option>
                    <option value="anthropic">Anthropic API</option>
                    <option value="openai">OpenAI API</option>
                    <option value="ollama">Ollama (local)</option>
                    <option value="custom">Custom OpenAI-compatible</option>
                  </Select>
                </Field>
                <Field label="Model override" hint="Leave blank to use each provider's default.">
                  <Input
                    value={s.llmModel}
                    onChange={(e) => set({ llmModel: e.target.value })}
                    placeholder="claude-sonnet-5"
                  />
                </Field>

                <div className="grid grid-cols-2 gap-3">
                  <Field label="Anthropic API key">
                    <Input
                      type="password"
                      value={s.anthropicApiKey}
                      onChange={(e) => set({ anthropicApiKey: e.target.value })}
                      placeholder="sk-ant-…"
                    />
                  </Field>
                  <Field label="OpenAI API key">
                    <Input
                      type="password"
                      value={s.openaiApiKey}
                      onChange={(e) => set({ openaiApiKey: e.target.value })}
                      placeholder="sk-…"
                    />
                  </Field>
                  <Field label="Ollama URL">
                    <Input
                      value={s.ollamaBaseUrl}
                      onChange={(e) => set({ ollamaBaseUrl: e.target.value })}
                      placeholder="http://127.0.0.1:11434"
                    />
                  </Field>
                  <Field label="Ollama model">
                    <Input
                      value={s.ollamaModel}
                      onChange={(e) => set({ ollamaModel: e.target.value })}
                      placeholder="llama3.1"
                    />
                  </Field>
                  <Field label="Custom base URL">
                    <Input
                      value={s.customBaseUrl}
                      onChange={(e) => set({ customBaseUrl: e.target.value })}
                      placeholder="https://…/v1"
                    />
                  </Field>
                  <Field label="Custom model">
                    <Input
                      value={s.customModel}
                      onChange={(e) => set({ customModel: e.target.value })}
                    />
                  </Field>
                </div>
              </Card>

              <Card className="flex flex-col gap-4 p-4">
                <Field
                  label="Transcription"
                  hint="whisper.cpp runs entirely on your machine and fetches a ~140MB model the first time. Groq and OpenAI are faster but send your audio to their servers."
                >
                  <Select value={s.sttProvider} onChange={(e) => set({ sttProvider: e.target.value })}>
                    <option value="auto">Auto</option>
                    <option value="whisper-cpp">whisper.cpp (local)</option>
                    <option value="groq">Groq</option>
                    <option value="openai">OpenAI</option>
                  </Select>
                </Field>
                {whisperMissing && (
                  <div className="flex items-center gap-3 rounded-lg border border-white/10 bg-white/[0.03] p-3">
                    <div className="min-w-0 flex-1 text-[12px] text-white/60">
                      {installing
                        ? installing
                        : sttRoute === 'homebrew'
                          ? 'Local transcription needs whisper.cpp. Showoff will run `brew install whisper-cpp`.'
                          : sttRoute === 'download'
                            ? 'Local transcription needs whisper.cpp. Showoff downloads it the first time you transcribe.'
                            : 'No prebuilt whisper.cpp for this platform. Build it and set the path below, or use Groq or OpenAI.'}
                    </div>
                    {sttRoute && (
                      <Button
                        className="shrink-0"
                        disabled={installing !== null}
                        onClick={() => void installWhisper()}
                      >
                        {installing ? <Spinner /> : 'Install Whisper'}
                      </Button>
                    )}
                  </div>
                )}
                <div className="grid grid-cols-2 gap-3">
                  <Field label="whisper-cli path" hint="Leave blank to auto-detect or download.">
                    <Input value={s.whisperBin} onChange={(e) => set({ whisperBin: e.target.value })} />
                  </Field>
                  <Field label="Groq API key">
                    <Input
                      type="password"
                      value={s.groqApiKey}
                      onChange={(e) => set({ groqApiKey: e.target.value })}
                      placeholder="gsk_…"
                    />
                  </Field>
                </div>
              </Card>
            </div>
          )}

          {section === 'output' && (
            <div className="flex max-w-2xl flex-col gap-5">
              <Card className="p-4">
                <div className="mb-3 text-[13px] font-medium">Default platforms</div>
                <div className="grid grid-cols-2 gap-2">
                  {PLATFORM_IDS.map((id) => {
                    const on = (s.platforms as PlatformId[]).includes(id)
                    return (
                      <button
                        key={id}
                        onClick={() =>
                          set({
                            platforms: on
                              ? (s.platforms as PlatformId[]).filter((p) => p !== id)
                              : [...(s.platforms as PlatformId[]), id]
                          })
                        }
                        className={cls(
                          'rounded-[10px] border px-3 py-2.5 text-left transition-colors',
                          on ? 'border-[#F5A524] bg-[#F5A524]/8' : 'border-[#262a31] bg-[#0f1115]'
                        )}
                      >
                        <div className="text-[13px]">{PLATFORMS[id].label}</div>
                        <div className="mono mt-0.5 text-[11px] text-[#6b727d]">
                          {PLATFORMS[id].width}×{PLATFORMS[id].height}
                        </div>
                      </button>
                    )
                  })}
                </div>
              </Card>

              <Card className="flex flex-col gap-1 p-4">
                <Toggle
                  checked={s.burnCaptions}
                  onChange={(v) => set({ burnCaptions: v })}
                  label="Burn captions into clips"
                  hint="Most feeds autoplay muted. Without captions the clip is a silent movie."
                />
                <Toggle
                  checked={s.webcamPip}
                  onChange={(v) => set({ webcamPip: v })}
                  label="Overlay webcam picture-in-picture"
                  hint="Only applies when a webcam track was recorded."
                />
                <Toggle
                  checked={s.trimSilence}
                  onChange={(v) => set({ trimSilence: v })}
                  label="Trim dead air at clip edges"
                  hint="Snaps clip boundaries away from long silences so posts do not open on you inhaling."
                />
                <div className="mt-3">
                  <Field label="Clips per cut">
                    <Select value={s.maxClips} onChange={(e) => set({ maxClips: Number(e.target.value) })}>
                      {[1, 2, 3, 4, 5, 6, 8, 10].map((n) => (
                        <option key={n} value={n}>
                          {n}
                        </option>
                      ))}
                    </Select>
                  </Field>
                </div>
              </Card>
            </div>
          )}

          {section === 'prompts' && (
            <div className="flex max-w-3xl flex-col gap-5">
              <p className="text-[12.5px] leading-relaxed text-[#9aa1ab]">
                These are the actual prompts. Placeholders in braces are filled in before sending —
                <span className="mono"> {'{transcript}'}</span>,
                <span className="mono"> {'{platforms}'}</span>,
                <span className="mono"> {'{context}'}</span>,
                <span className="mono"> {'{answers}'}</span>,
                <span className="mono"> {'{maxClips}'}</span>.
              </p>
              <PromptBox
                label="Clip plan"
                value={s.promptClipPlan}
                onChange={(v) => set({ promptClipPlan: v })}
              />
              <PromptBox
                label="Clarifying questions"
                value={s.promptQuestions}
                onChange={(v) => set({ promptQuestions: v })}
              />
              <PromptBox label="Notes" value={s.promptNotes} onChange={(v) => set({ promptNotes: v })} />
              <div>
                <Button
                  size="sm"
                  variant="ghost"
                  onClick={async () => {
                    const d = await soft(api.settings.defaults(), null)
                    if (!d) return
                    set({
                      promptClipPlan: d.promptClipPlan,
                      promptQuestions: d.promptQuestions,
                      promptNotes: d.promptNotes
                    })
                    toast.ok('Prompts reset to defaults')
                  }}
                >
                  Reset prompts to defaults
                </Button>
              </div>
            </div>
          )}

          {section === 'storage' && (
            <div className="flex max-w-2xl flex-col gap-5">
              <Card className="p-4">
                <Field
                  label="Recordings folder"
                  hint="Video, audio, clips and bundles live here. The database and models live in the app's own data folder."
                >
                  <div className="flex gap-2">
                    <Input value={s.storageDir} readOnly className="mono text-[12px]" />
                    <Button
                      size="sm"
                      onClick={async () => {
                        const next = await soft(api.settings.pickStorageDir(), null)
                        if (next) {
                          toast.ok('Storage folder changed', 'Existing recordings stay where they are.')
                          void shell.saveSettings({})
                        }
                      }}
                    >
                      Change
                    </Button>
                    <Button size="sm" variant="ghost" onClick={() => void soft(api.shell.openPath(s.storageDir), false)}>
                      Open
                    </Button>
                  </div>
                </Field>
              </Card>

              {info && (
                <Card className="p-4">
                  <div className="mb-2 text-[13px] font-medium">About</div>
                  <dl className="flex flex-col gap-1.5 text-[12px]">
                    <Row k="Version" v={info.version} />
                    <Row k="Platform" v={info.platform} />
                    <Row k="Log file" v={info.logPath} />
                  </dl>
                  <div className="mt-3 flex gap-2">
                    <Button size="sm" variant="ghost" onClick={() => void soft(api.shell.showItem(info.logPath), false)}>
                      Show log
                    </Button>
                    <Button
                      size="sm"
                      variant="ghost"
                      onClick={() => void soft(api.shell.openExternal('https://github.com/rondorkerin/showoff'), false)}
                    >
                      GitHub
                    </Button>
                  </div>
                </Card>
              )}
            </div>
          )}
        </div>
      </div>
    </div>
  )
}

function Row({ k, v }: { k: string; v: string }): React.ReactElement {
  return (
    <div className="flex gap-3">
      <dt className="w-[80px] shrink-0 text-[#6b727d]">{k}</dt>
      <dd className="mono min-w-0 flex-1 break-all text-[11.5px] text-[#9aa1ab]">{v}</dd>
    </div>
  )
}

function StatusList({ label, items }: { label: string; items: ProviderStatus[] }): React.ReactElement {
  return (
    <div>
      <div className="mb-1.5 text-[11.5px] font-medium uppercase tracking-wide text-[#6b727d]">
        {label}
      </div>
      <div className="flex flex-col gap-1">
        {items.map((p) => (
          <div key={p.id} className="flex items-baseline gap-2.5">
            <span
              className={cls(
                'mt-[5px] inline-block h-[6px] w-[6px] shrink-0 rounded-full',
                p.available ? 'bg-[#4ade80]' : 'bg-[#3a4048]'
              )}
            />
            <span className="w-[150px] shrink-0 text-[12.5px]">{p.label}</span>
            <span className="mono min-w-0 flex-1 truncate text-[11px] text-[#6b727d]" title={p.detail}>
              {p.detail || (p.available ? 'ready' : 'not configured')}
            </span>
          </div>
        ))}
      </div>
    </div>
  )
}

function PromptBox({
  label,
  value,
  onChange
}: {
  label: string
  value: string
  onChange: (v: string) => void
}): React.ReactElement {
  const [local, setLocal] = useState(value)
  useEffect(() => setLocal(value), [value])
  return (
    <div>
      <div className="mb-1.5 flex items-center justify-between">
        <span className="text-[12px] font-medium text-[#9aa1ab]">{label}</span>
        {local !== value && (
          <Button size="sm" variant="primary" onClick={() => onChange(local)}>
            Save
          </Button>
        )}
      </div>
      <Textarea
        rows={10}
        value={local}
        onChange={(e) => setLocal(e.target.value)}
        className="mono text-[11.5px] leading-relaxed"
      />
    </div>
  )
}
