/**
 * Every failure in Showoff has a name. Nothing is caught as a bare Error and
 * nothing is swallowed — the UI shows the code, the remedy, and (where it
 * exists) the underlying detail.
 */
export class ShowoffError extends Error {
  readonly code: string
  readonly remedy: string
  readonly detail: string

  constructor(code: string, message: string, remedy = '', detail = '') {
    super(message)
    this.name = code
    this.code = code
    this.remedy = remedy
    this.detail = detail
  }

  toJSON(): { code: string; message: string; remedy: string; detail: string } {
    return { code: this.code, message: this.message, remedy: this.remedy, detail: this.detail }
  }
}

export const NoCaptureSourcesError = (detail = ''): ShowoffError =>
  new ShowoffError(
    'NoCaptureSourcesError',
    'No screen sources are available to record.',
    'Grant screen recording permission to Showoff, then reopen the source picker.',
    detail
  )

export const EmptyRecordingError = (detail = ''): ShowoffError =>
  new ShowoffError(
    'EmptyRecordingError',
    'That recording captured no data.',
    'Record for at least a couple of seconds before stopping.',
    detail
  )

export const FfmpegError = (detail: string): ShowoffError =>
  new ShowoffError(
    'FfmpegError',
    'ffmpeg failed while processing the video.',
    'Retry. If it keeps failing, copy the detail below into a bug report.',
    detail
  )

export const MediaTooShortError = (detail = ''): ShowoffError =>
  new ShowoffError(
    'MediaTooShortError',
    'This recording is too short to cut into clips.',
    'Record at least 10 seconds of narration.',
    detail
  )

export const TranscriptionUnavailableError = (detail = ''): ShowoffError =>
  new ShowoffError(
    'TranscriptionUnavailableError',
    'No transcription provider is available.',
    'Open Settings and pick a transcription provider (local Whisper, Groq, or OpenAI).',
    detail
  )

export const TranscriptionFailedError = (detail: string): ShowoffError =>
  new ShowoffError(
    'TranscriptionFailedError',
    'Transcription failed.',
    'Your recording is safe. Retry, or switch providers in Settings.',
    detail
  )

export const NoSpeechError = (detail = ''): ShowoffError =>
  new ShowoffError(
    'NoSpeechError',
    'No speech was found in this recording.',
    'Check that the right microphone was selected, then record again.',
    detail
  )

export const LlmUnavailableError = (detail = ''): ShowoffError =>
  new ShowoffError(
    'LlmUnavailableError',
    'No language model is available.',
    'Open Settings and pick a model. If you have Claude Code installed, the Claude CLI option needs no API key.',
    detail
  )

export const LlmRequestError = (detail: string): ShowoffError =>
  new ShowoffError(
    'LlmRequestError',
    'The language model request failed.',
    'Check the provider and key in Settings, then retry.',
    detail
  )

export const LlmSchemaError = (detail: string): ShowoffError =>
  new ShowoffError(
    'LlmSchemaError',
    'The model returned a response Showoff could not read.',
    'Retry. If it repeats, try a larger model in Settings.',
    detail
  )

export const DbMigrationError = (detail: string): ShowoffError =>
  new ShowoffError(
    'DbMigrationError',
    'The Showoff database could not be prepared.',
    'Your recordings are untouched. Copy the detail below into a bug report.',
    detail
  )

export const NotFoundError = (what: string): ShowoffError =>
  new ShowoffError('NotFoundError', `${what} was not found.`, 'Refresh and try again.', '')

export function serializeError(e: unknown): {
  code: string
  message: string
  remedy: string
  detail: string
} {
  if (e instanceof ShowoffError) return e.toJSON()
  if (e instanceof Error)
    return { code: e.name || 'Error', message: e.message, remedy: '', detail: e.stack ?? '' }
  return { code: 'Error', message: String(e), remedy: '', detail: '' }
}
