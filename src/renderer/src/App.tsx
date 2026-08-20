import React, { useCallback, useEffect, useMemo, useState } from 'react'
import { api, soft } from './lib/api.ts'
import { cls } from './lib/format.ts'
import { ToastProvider, useToast } from './components/Toasts.tsx'
import { Bar } from './components/ui.tsx'
import Studio from './views/Studio.tsx'
import Library from './views/Library.tsx'
import Editor from './views/Editor.tsx'
import Settings from './views/Settings.tsx'
import RecordingBar from './components/RecordingBar.tsx'
import { RecordingProvider, RecordingSync } from './lib/recording.tsx'
import type { JobEvent } from '../../preload/index.ts'
import type { AppSettings, Project } from '../../shared/types.ts'

export type Route =
  | { name: 'studio' }
  | { name: 'library' }
  | { name: 'recording'; id: string }
  | { name: 'settings' }

export interface Shell {
  route: Route
  go: (r: Route) => void
  projects: Project[]
  reloadProjects: () => Promise<void>
  settings: AppSettings | null
  saveSettings: (patch: Partial<AppSettings>) => Promise<void>
  jobs: JobEvent[]
  /** Bumped whenever a job finishes, so open views can refetch. */
  jobTick: number
  recording: boolean
  setRecording: (v: boolean) => void
}

function Nav({
  active,
  onClick,
  icon,
  label,
  badge
}: {
  active: boolean
  onClick: () => void
  icon: React.ReactNode
  label: string
  badge?: React.ReactNode
}): React.ReactElement {
  return (
    <button
      onClick={onClick}
      className={cls(
        'no-drag flex w-full items-center gap-2.5 rounded-[10px] px-3 py-2 text-[13px] transition-colors',
        active ? 'bg-[#191c21] text-[#e9eaec]' : 'text-[#9aa1ab] hover:bg-[#15181d] hover:text-[#e9eaec]'
      )}
    >
      <span className={cls('shrink-0', active ? 'text-[#F5A524]' : 'text-[#6b727d]')}>{icon}</span>
      <span className="flex-1 text-left">{label}</span>
      {badge}
    </button>
  )
}

const IconStudio = (
  <svg width="15" height="15" viewBox="0 0 16 16" fill="none">
    <circle cx="8" cy="8" r="5" fill="currentColor" />
  </svg>
)
const IconLibrary = (
  <svg width="15" height="15" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5">
    <rect x="2" y="3" width="12" height="10" rx="2" />
    <path d="M6.5 6.5v3l3-1.5-3-1.5Z" fill="currentColor" stroke="none" />
  </svg>
)
const IconSettings = (
  <svg width="15" height="15" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5">
    <circle cx="8" cy="8" r="2.2" />
    <path d="M8 1.6v1.6M8 12.8v1.6M14.4 8h-1.6M3.2 8H1.6M12.5 3.5l-1.1 1.1M4.6 11.4l-1.1 1.1M12.5 12.5l-1.1-1.1M4.6 4.6 3.5 3.5" />
  </svg>
)

function Inner(): React.ReactElement {
  const toast = useToast()
  const [route, setRoute] = useState<Route>({ name: 'studio' })
  const [projects, setProjects] = useState<Project[]>([])
  const [settings, setSettings] = useState<AppSettings | null>(null)
  const [jobs, setJobs] = useState<JobEvent[]>([])
  const [jobTick, setJobTick] = useState(0)
  const [recording, setRecording] = useState(false)

  const reloadProjects = useCallback(async () => {
    setProjects(await soft(api.projects.list(), []))
  }, [])

  useEffect(() => {
    void reloadProjects()
    void soft(api.settings.get(), null).then((s) => s && setSettings(s))

    // Anything left half-written by a crash is offered back rather than
    // silently abandoned in the storage folder. Library does the offering --
    // this only points at it, so the notice cannot be dismissed into oblivion.
    void soft(api.recordings.interrupted(), []).then((rows) => {
      if (rows.length > 0) {
        toast.push({
          tone: 'info',
          title: `${rows.length} recording${rows.length > 1 ? 's' : ''} did not finish`,
          body: 'The footage is still on disk. Library can put it back together.',
          detail: rows[0].dir
        })
      }
    })
  }, [reloadProjects, toast])

  useEffect(() => {
    return api.onUpdate((info) => {
      toast.push({
        tone: 'info',
        title: `Showoff ${info.version} is out`,
        body: 'Settings → Storage can download and install it for you.',
        detail: info.url
      })
    })
  }, [toast])

  useEffect(() => {
    return api.onJob((event, payload) => {
      setJobs((list) => {
        const rest = list.filter((j) => j.id !== payload.id)
        if (event === 'job:done' || event === 'job:failed') return rest
        return [...rest, payload]
      })
      if (event === 'job:done') {
        setJobTick((n) => n + 1)
        if (payload.kind !== 'finalize') {
          toast.ok(doneLabel(payload.kind))
        }
      }
      if (event === 'job:failed') {
        setJobTick((n) => n + 1)
        toast.push({
          tone: 'bad',
          title: `${failLabel(payload.kind)}`,
          body: payload.error?.message ?? 'Unknown error',
          detail: payload.error?.remedy
        })
      }
    })
  }, [toast])

  const saveSettings = useCallback(
    async (patch: Partial<AppSettings>) => {
      const next = await soft(api.settings.save(patch), null)
      if (next) setSettings(next)
    },
    []
  )

  const shell: Shell = useMemo(
    () => ({
      route,
      go: setRoute,
      projects,
      reloadProjects,
      settings,
      saveSettings,
      jobs,
      jobTick,
      recording,
      setRecording
    }),
    [route, projects, reloadProjects, settings, saveSettings, jobs, jobTick, recording]
  )

  const activeJob = jobs.find((j) => j.status === 'running') ?? jobs[0] ?? null

  // Owned here rather than in Studio: the recorder outlives that screen now, so
  // whatever happens when a take lands has to outlive it too.
  const onFinalized = useCallback(
    (id: string) => {
      toast.ok('Recording saved', 'Transcribing it now.')
      void api.pipeline.transcribe(id)
      setRoute({ name: 'recording', id })
    },
    [toast]
  )

  return (
    <RecordingProvider onFinalized={onFinalized}>
    <RecordingSync onChange={setRecording} />
    <div className={cls('flex h-full', recording && 'recording-chrome')}>
      <aside className="drag-region flex w-[212px] shrink-0 flex-col border-r border-[#1d2026] bg-[#0e0f12] px-3 pb-3 pt-[38px]">
        <div className="mb-5 flex items-center gap-2 px-2">
          <span
            className={cls(
              'inline-block h-[9px] w-[9px] rounded-full',
              recording ? 'rec-dot bg-[#F5A524]' : 'bg-[#3a4048]'
            )}
          />
          <span className="text-[14px] font-semibold tracking-tight">Showoff</span>
        </div>

        <nav className="flex flex-col gap-0.5">
          <Nav
            active={route.name === 'studio'}
            onClick={() => setRoute({ name: 'studio' })}
            icon={IconStudio}
            label="Studio"
          />
          <Nav
            active={route.name === 'library' || route.name === 'recording'}
            onClick={() => setRoute({ name: 'library' })}
            icon={IconLibrary}
            label="Library"
          />
          <Nav
            active={route.name === 'settings'}
            onClick={() => setRoute({ name: 'settings' })}
            icon={IconSettings}
            label="Settings"
          />
        </nav>

        <div className="flex-1" />

        {activeJob && (
          <div className="no-drag rounded-[10px] border border-[#262a31] bg-[#121418] px-3 py-2.5">
            <div className="mb-1.5 flex items-baseline justify-between gap-2">
              <span className="truncate text-[12px] text-[#e9eaec]">
                {stageLabel(activeJob)}
              </span>
              <span className="mono shrink-0 text-[11px] text-[#6b727d]">
                {Math.round((activeJob.progress ?? 0) * 100)}%
              </span>
            </div>
            <Bar value={activeJob.progress ?? 0} />
            {jobs.length > 1 && (
              <div className="mt-1.5 text-[11px] text-[#6b727d]">
                {jobs.length - 1} more queued
              </div>
            )}
          </div>
        )}
      </aside>

      <main className="flex min-w-0 flex-1 flex-col overflow-hidden">
        {route.name !== 'studio' && (
          <RecordingBar onOpenStudio={() => setRoute({ name: 'studio' })} />
        )}
        <div className="min-h-0 flex-1 overflow-hidden">
          {route.name === 'studio' && <Studio shell={shell} />}
          {route.name === 'library' && <Library shell={shell} />}
          {route.name === 'recording' && <Editor shell={shell} id={route.id} />}
          {route.name === 'settings' && <Settings shell={shell} />}
        </div>
      </main>
    </div>
    </RecordingProvider>
  )
}

function stageLabel(job: JobEvent): string {
  const kind =
    {
      finalize: 'Saving recording',
      transcribe: 'Transcribing',
      cut: 'Cutting clips',
      notes: 'Writing notes',
      rerender: 'Re-rendering'
    }[job.kind] ?? job.kind
  return job.stage && job.stage !== 'Starting' ? `${kind} · ${job.stage}` : kind
}

function doneLabel(kind: string): string {
  return (
    {
      transcribe: 'Transcript ready',
      cut: 'Clips are ready',
      notes: 'Notes written',
      rerender: 'Clip re-rendered'
    }[kind] ?? 'Done'
  )
}

function failLabel(kind: string): string {
  return (
    {
      finalize: 'Could not save the recording',
      transcribe: 'Transcription failed',
      cut: 'Cutting clips failed',
      notes: 'Writing notes failed',
      rerender: 'Re-render failed'
    }[kind] ?? 'Job failed'
  )
}

export default function App(): React.ReactElement {
  return (
    <ToastProvider>
      <Inner />
    </ToastProvider>
  )
}
