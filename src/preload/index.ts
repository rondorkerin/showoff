import { contextBridge, ipcRenderer } from 'electron'
import type {
  AppSettings,
  ClarifyingQuestion,
  Clip,
  ClipRender,
  Diagnostics,
  Job,
  Note,
  Project,
  Recording,
  Track,
  TranscriptSegment,
  TrackKind
} from '../shared/types.ts'
import type { PlatformId, PlatformSpec } from '../shared/platforms.ts'

export interface IpcError {
  code: string
  message: string
  remedy: string
  detail: string
}

export type Result<T> = { ok: true; data: T } | { ok: false; error: IpcError }

async function call<T>(channel: string, ...args: unknown[]): Promise<Result<T>> {
  try {
    return (await ipcRenderer.invoke(channel, ...args)) as Result<T>
  } catch (e) {
    return {
      ok: false,
      error: {
        code: 'IpcError',
        message: e instanceof Error ? e.message : String(e),
        remedy: 'Restart Showoff. If it keeps happening, check the log file in Settings.',
        detail: ''
      }
    }
  }
}

export interface CaptureSource {
  id: string
  name: string
  kind: 'screen' | 'window'
  thumbnail: string
}

export interface RecordingDetail {
  recording: Recording
  tracks: Track[]
  transcript: { id: string; provider: string; text: string; segments: TranscriptSegment[] } | null
  clips: Clip[]
  renders: ClipRender[]
  note: Note | null
  tags: string[]
  job: Job | null
}

export interface JobEvent {
  id: string
  kind: string
  recordingId: string | null
  status: string
  stage?: string
  progress?: number
  error?: IpcError
  result?: unknown
}

export interface SearchHit {
  recording_id: string
  recording_title: string
  kind: string
  text: string
  start_ms: number | null
  score: number
  source: 'semantic' | 'text'
}

const api = {
  sources: {
    list: () => call<CaptureSource[]>('sources:list')
  },
  recording: {
    start: (input: { title: string; projectId: string | null; kinds: TrackKind[] }) =>
      call<{ recordingId: string; dir: string }>('recording:start', input),
    // Fire-and-forget so a 2s chunk never blocks the recorder on a round trip.
    chunk: (recordingId: string, kind: TrackKind, chunk: ArrayBuffer) =>
      ipcRenderer.send('recording:chunk', { recordingId, kind, chunk }),
    finalize: (recordingId: string) => call<JobEvent>('recording:finalize', recordingId),
    cancel: (recordingId: string) => call<void>('recording:cancel', recordingId),
    orphans: () => call<Array<{ dir: string; path: string; bytes: number }>>('recording:orphans')
  },
  voiceover: {
    start: (recordingId: string) => call<{ dir: string }>('voiceover:start', recordingId),
    finalize: (recordingId: string) => call<{ path: string }>('voiceover:finalize', recordingId)
  },
  projects: {
    list: () => call<Project[]>('projects:list'),
    create: (p: { name: string; context: string }) => call<Project>('projects:create', p),
    update: (p: { id: string; name?: string; context?: string }) =>
      call<Project>('projects:update', p),
    remove: (id: string) => call<void>('projects:delete', id)
  },
  recordings: {
    list: (projectId: string | null) => call<Recording[]>('recordings:list', projectId),
    get: (id: string) => call<RecordingDetail | null>('recordings:get', id),
    update: (p: { id: string; title?: string; projectId?: string | null }) =>
      call<void>('recordings:update', p),
    remove: (id: string) => call<void>('recordings:delete', id),
    setTags: (id: string, tags: string[]) => call<void>('recordings:tags', { id, tags })
  },
  pipeline: {
    transcribe: (recordingId: string) => call<JobEvent>('pipeline:transcribe', recordingId),
    questions: (recordingId: string) => call<ClarifyingQuestion[]>('pipeline:questions', recordingId),
    cut: (opts: {
      recordingId: string
      answers: Array<{ question: string; answer: string }>
      platforms?: PlatformId[]
      maxClips?: number
    }) => call<JobEvent>('pipeline:cut', opts),
    notes: (recordingId: string) => call<JobEvent>('pipeline:notes', recordingId),
    reindex: (recordingId: string) => call<{ chunks: number }>('pipeline:reindex', recordingId)
  },
  clips: {
    update: (p: { id: string; title?: string; description?: string; hashtags?: string[] }) =>
      call<void>('clips:update', p),
    remove: (id: string) => call<void>('clips:delete', id),
    rerender: (id: string) => call<JobEvent>('clips:rerender', id),
    shareText: (id: string) => call<string>('clips:shareText', id)
  },
  notes: {
    save: (p: { recordingId: string; title: string; body: string }) => call<Note>('notes:save', p)
  },
  search: (q: string) => call<SearchHit[]>('search', q),
  tags: () => call<string[]>('tags:list'),
  stats: () => call<{ recordings: number; clips: number; minutes: number }>('stats'),
  exportBundle: (recordingId: string) =>
    call<{ cancelled: boolean; dir: string; clips?: number }>('export:bundle', recordingId),
  shell: {
    showItem: (path: string) => call<boolean>('shell:showItem', path),
    openPath: (path: string) => call<boolean>('shell:openPath', path),
    openExternal: (url: string) => call<boolean>('shell:openExternal', url)
  },
  settings: {
    get: () => call<AppSettings>('settings:get'),
    save: (patch: Partial<AppSettings>) => call<AppSettings>('settings:save', patch),
    defaults: () => call<AppSettings>('settings:defaults'),
    pickStorageDir: () => call<AppSettings | null>('settings:pickStorageDir')
  },
  platforms: () => call<Record<PlatformId, PlatformSpec>>('platforms'),
  diagnostics: () => call<Diagnostics>('diagnostics'),
  appInfo: () =>
    call<{ version: string; platform: string; logPath: string; userData: string }>('app:info'),
  setAlwaysOnTop: (on: boolean) => call<boolean>('window:minimizeToHud', on),

  /** Turns an absolute file path into a URL the renderer is allowed to load. */
  mediaUrl: (path: string) => `showoff://media/?p=${encodeURIComponent(path)}`,

  onJob: (fn: (event: string, payload: JobEvent) => void) => {
    const channels = ['job:queued', 'job:update', 'job:done', 'job:failed']
    const listeners = channels.map((c) => {
      const l = (_e: unknown, payload: JobEvent): void => fn(c, payload)
      ipcRenderer.on(c, l)
      return { c, l }
    })
    return () => listeners.forEach(({ c, l }) => ipcRenderer.removeListener(c, l))
  }
}

export type ShowoffApi = typeof api

contextBridge.exposeInMainWorld('showoff', api)
