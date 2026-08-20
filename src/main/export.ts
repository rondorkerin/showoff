import * as repo from './db/repo.ts'
import { cuesForWindow, renderComposite, type RenderResult } from './media/render.ts'
import { outputSize, projectDurationMs, reconcileLanes, toComposite } from './lanes.ts'
import { MediaTooShortError, NotFoundError } from '../shared/errors.ts'
import type { Aspect } from '../shared/types.ts'
import { log } from './log.ts'

export interface ExportOptions {
  recordingId: string
  outputPath: string
  aspect?: Aspect
  subtitles?: boolean
}

/**
 * The whole project, as one file, wherever the user asked for it.
 *
 * This is the primitive the app never had: until now the only way to get a
 * finished video out was to let the clip pipeline decide what to cut. Export is
 * deliberately the plainest thing in the codebase -- it takes the lanes exactly
 * as they are arranged and writes them down.
 */
export async function exportRecording(
  opts: ExportOptions,
  onProgress: (stage: string, fraction: number) => void
): Promise<RenderResult> {
  const rec = await repo.getRecording(opts.recordingId)
  if (!rec) throw NotFoundError('Recording')

  const lanes = await reconcileLanes(opts.recordingId)
  if (lanes.length === 0) throw NotFoundError('Recording media')

  const aspect = opts.aspect ?? rec.aspect ?? 'source'
  const { width, height } = outputSize(rec, aspect)
  const durationMs = projectDurationMs(lanes, rec.duration_ms ?? 0)
  if (durationMs < 500) throw MediaTooShortError('there is nothing on the timeline to export')

  let captions: ReturnType<typeof cuesForWindow> = []
  if (opts.subtitles) {
    const transcript = await repo.getTranscript(opts.recordingId)
    if (transcript) {
      captions = cuesForWindow(
        transcript.segments.map((x) => ({
          start_ms: x.start_ms,
          end_ms: x.end_ms,
          text: x.text
        })),
        0,
        durationMs
      )
    }
  }

  onProgress('Composing', 0.02)
  const result = await renderComposite({
    lanes: toComposite(lanes, aspect),
    width,
    height,
    startMs: 0,
    endMs: durationMs,
    outputPath: opts.outputPath,
    captions,
    burnCaptions: captions.length > 0,
    label: 'export',
    onProgress: (f) => onProgress('Composing', 0.02 + f * 0.97)
  })

  log.info('export', 'wrote file', {
    recordingId: opts.recordingId,
    path: result.path,
    aspect,
    bytes: result.bytes
  })
  return result
}

/** A sensible filename for the save dialog: the title, not a uuid. */
export function suggestedFilename(title: string, aspect: Aspect): string {
  const slug =
    title
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 60) || 'showoff'
  const suffix = aspect === 'source' ? '' : `-${aspect.replace(':', 'x')}`
  return `${slug}${suffix}.mp4`
}
