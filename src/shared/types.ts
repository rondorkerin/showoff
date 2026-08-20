import type { PlatformId } from './platforms'

export type TrackKind = 'screen' | 'mic' | 'webcam' | 'voiceover'

export interface Project {
  id: string
  name: string
  context: string | null
  created_at: string
}

export interface Recording {
  id: string
  project_id: string | null
  title: string
  dir: string
  duration_ms: number | null
  width: number | null
  height: number | null
  poster_path: string | null
  status: 'recording' | 'ready' | 'failed'
  error: string | null
  created_at: string
}

export interface Track {
  id: string
  recording_id: string
  kind: TrackKind
  path: string
  duration_ms: number | null
  created_at: string
}

export interface TranscriptSegment {
  id: string
  transcript_id: string
  idx: number
  start_ms: number
  end_ms: number
  text: string
}

export interface Transcript {
  id: string
  recording_id: string
  provider: string
  language: string | null
  text: string
  created_at: string
}

export interface Note {
  id: string
  recording_id: string | null
  project_id: string | null
  title: string
  body: string
  created_at: string
  updated_at: string
}

export interface Clip {
  id: string
  recording_id: string
  platform: PlatformId
  title: string
  description: string
  hashtags: string[]
  hook: string
  reason: string
  score: number
  start_ms: number
  end_ms: number
  rank: number
  created_at: string
}

export interface ClipRender {
  id: string
  clip_id: string
  path: string
  poster_path: string | null
  width: number
  height: number
  duration_ms: number
  bytes: number
  captions: boolean
  webcam_pip: boolean
  created_at: string
}

export interface Job {
  id: string
  recording_id: string | null
  kind: string
  status: 'queued' | 'running' | 'done' | 'failed'
  stage: string | null
  progress: number
  error: string | null
  created_at: string
  updated_at: string
}

export interface ProviderStatus {
  id: string
  label: string
  available: boolean
  detail: string
}

export interface Diagnostics {
  llm: ProviderStatus[]
  stt: ProviderStatus[]
  binaries: ProviderStatus[]
  db: ProviderStatus
  storageDir: string
}

export interface AppSettings {
  storageDir: string
  llmProvider: string
  llmModel: string
  sttProvider: string
  anthropicApiKey: string
  openaiApiKey: string
  groqApiKey: string
  ollamaBaseUrl: string
  ollamaModel: string
  customBaseUrl: string
  customApiKey: string
  customModel: string
  whisperBin: string
  whisperModel: string
  burnCaptions: boolean
  webcamPip: boolean
  trimSilence: boolean
  maxClips: number
  platforms: PlatformId[]
  promptClipPlan: string
  promptQuestions: string
  promptNotes: string
}

export interface ClarifyingQuestion {
  id: string
  question: string
  why: string
  suggestion: string
}
