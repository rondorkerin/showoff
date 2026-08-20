import type { PlatformId } from './platforms.ts'

/**
 * A lane is one source clip placed on a project's timeline. Lanes are the
 * whole edit model: there is deliberately no way to put two clips on one lane,
 * because lanes are free and that single constraint is what keeps this an
 * editor rather than a non-linear editor -- no splitting, no ripple delete, no
 * selection model, no undo stack.
 */
export type LaneKind = 'screen' | 'webcam' | 'mic' | 'system' | 'voiceover'

/** 'source' keeps whatever the footage already was. */
export type Aspect = 'source' | '16:9' | '9:16' | '1:1' | '4:5'

export const ASPECTS: Aspect[] = ['source', '16:9', '9:16', '1:1', '4:5']

export function isVideoLane(kind: LaneKind): boolean {
  return kind === 'screen' || kind === 'webcam'
}

/**
 * Where a video lane sits inside the frame. x/y are the centre of the lane as
 * a fraction of the output, scale is its width as a fraction of the output.
 * Stored per aspect, because a webcam framed for 16:9 is in the wrong place
 * once the output is 9:16.
 */
export interface LaneFrame {
  x: number
  y: number
  scale: number
}

export const DEFAULT_FRAME: LaneFrame = { x: 0.86, y: 0.85, scale: 0.24 }
export const FULL_FRAME: LaneFrame = { x: 0.5, y: 0.5, scale: 1 }

export interface Lane {
  id: string
  recording_id: string
  kind: LaneKind
  label: string
  path: string
  /** Full length of the source file. */
  source_ms: number | null
  /** Where this clip starts on the project timeline. */
  offset_ms: number
  /** Trim, measured inside the source file. */
  in_ms: number
  out_ms: number | null
  z: number
  enabled: boolean
  /** 1 = unity. */
  gain: number
  /** Audio only: duck the mic under this lane while it has speech. */
  ducks: boolean
  /** Keyed by aspect, plus a 'default' fallback. */
  frame: Record<string, LaneFrame>
  created_at: string | Date
}

/**
 * PGlite hands timestamps back as Date objects, not strings, and Electron's
 * structured clone keeps them that way across IPC -- so neither the main
 * process nor the renderer can assume it has a string to compare.
 */
export function createdAtMs(value: string | Date): number {
  return value instanceof Date ? value.getTime() : Date.parse(value)
}

/** Bottom of the stack first, ties broken by which lane arrived first. */
export function byStackOrder(a: Lane, b: Lane): number {
  return a.z - b.z || createdAtMs(a.created_at) - createdAtMs(b.created_at)
}

export interface LanePatch {
  label?: string
  offsetMs?: number
  inMs?: number
  outMs?: number | null
  z?: number
  enabled?: boolean
  gain?: number
  ducks?: boolean
  frame?: LaneFrame
  /** Which aspect the frame patch applies to. */
  aspect?: Aspect
}

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
  aspect: Aspect
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

export interface LoopbackStatus {
  /** Whether computer audio can be captured right now. */
  available: boolean
  /**
   * 'native' is Electron's own loopback (Windows). 'sidecar' is our
   * ScreenCaptureKit helper (macOS 13+), which needs nothing installed.
   * 'device' is a virtual audio device the user has to set up themselves.
   */
  route: 'native' | 'sidecar' | 'device' | 'none'
  detail: string
  remedy: string
  /** What a device label has to look like for the renderer to pick it. */
  devicePattern: string
  /** Whether Showoff can do the install itself. */
  installable: boolean
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
