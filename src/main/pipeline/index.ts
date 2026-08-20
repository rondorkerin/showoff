import { app } from 'electron'
import { existsSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'
import * as repo from '../db/repo.ts'
import { complete } from '../llm/index.ts'
import { transcribe, type SttConfig } from '../transcribe/index.ts'
import { extractAudioWav, posterFrame, renderClip, cuesForWindow, probe } from '../media/render.ts'
import { getSettings, resolveKey } from '../settings.ts'
import { embedTexts } from './embed.ts'
import {
  describePlatforms,
  fillTemplate,
  formatTranscript,
  parseClipPlan,
  type ValidatedClip
} from './plan.ts'
import { clarifyingQuestionsSchema, extractJson, notesSchema } from '../../shared/schemas.ts'
import { MediaTooShortError, NotFoundError, serializeError } from '../../shared/errors.ts'
import type { AppSettings, ClarifyingQuestion } from '../../shared/types.ts'
import type { PlatformId } from '../../shared/platforms.ts'
import { log } from '../log.ts'

export type ProgressFn = (stage: string, fraction: number) => void

function sttConfig(s: AppSettings, onProgress?: (f: number, note: string) => void): SttConfig {
  return {
    whisperBin: s.whisperBin,
    whisperModel: s.whisperModel,
    modelDir: join(app.getPath('userData'), 'models'),
    openaiApiKey: resolveKey('openai'),
    groqApiKey: resolveKey('groq'),
    onProgress
  }
}

function llmConfig(s: AppSettings): Parameters<typeof complete>[2] {
  return {
    anthropicApiKey: resolveKey('anthropic'),
    openaiApiKey: resolveKey('openai'),
    ollamaBaseUrl: s.ollamaBaseUrl,
    ollamaModel: s.ollamaModel,
    customBaseUrl: s.customBaseUrl,
    customApiKey: s.customApiKey,
    customModel: s.customModel,
    model: s.llmModel
  }
}

async function projectContext(recordingId: string): Promise<string> {
  const rec = await repo.getRecording(recordingId)
  if (!rec?.project_id) return ''
  const projects = await repo.listProjects()
  const p = projects.find((x) => x.id === rec.project_id)
  if (!p) return ''
  const parts = [`PROJECT: ${p.name}`]
  if (p.context) parts.push(`PROJECT CONTEXT: ${p.context}`)
  return parts.join('\n')
}

/* ------------------------------------------------------------ transcription */

export async function runTranscription(
  recordingId: string,
  onProgress: ProgressFn
): Promise<{ segments: number }> {
  const s = getSettings()
  const rec = await repo.getRecording(recordingId)
  if (!rec) throw NotFoundError('Recording')

  const master = await repo.getTrack(recordingId, 'screen')
  const voiceover = await repo.getTrack(recordingId, 'voiceover')
  // A voice-over pass replaces the original narration as the thing to transcribe.
  const source = voiceover?.path ?? master?.path
  if (!source || !existsSync(source)) throw NotFoundError('Recording media')

  onProgress('Extracting audio', 0.05)
  const wav = join(rec.dir, 'audio.wav')
  await extractAudioWav(source, wav)

  const result = await transcribe(
    wav,
    s.sttProvider,
    sttConfig(s, (f, note) => onProgress(note, 0.1 + f * 0.85))
  )

  onProgress('Saving transcript', 0.97)
  await repo.saveTranscript(
    recordingId,
    result.provider,
    result.language,
    result.text,
    result.segments
  )
  return { segments: result.segments.length }
}

/* ---------------------------------------------------- clarifying questions */

export async function askClarifyingQuestions(
  recordingId: string
): Promise<ClarifyingQuestion[]> {
  const s = getSettings()
  const transcript = await repo.getTranscript(recordingId)
  if (!transcript || transcript.segments.length === 0) return []

  const prompt = fillTemplate(s.promptQuestions, {
    transcript: formatTranscript(
      transcript.segments.map((x) => ({
        startMs: x.start_ms,
        endMs: x.end_ms,
        text: x.text
      })),
      20000
    ),
    context: await projectContext(recordingId),
    maxQuestions: '4'
  })

  const { text } = await complete(
    { prompt, system: 'You output raw JSON and nothing else.', temperature: 0.3, maxTokens: 1200 },
    s.llmProvider,
    llmConfig(s)
  )

  const json = extractJson(text)
  const parsed = clarifyingQuestionsSchema.safeParse(json ?? {})
  if (!parsed.success) {
    // Questions are an enhancement, not a gate. If the model fumbles the shape,
    // proceed straight to the cut rather than blocking the whole pipeline.
    log.warn('pipeline', 'clarifying questions unparseable, skipping', {
      raw: text.slice(0, 400)
    })
    return []
  }

  return parsed.data.questions.map((q, i) => ({
    id: `q${i}`,
    question: q.question,
    why: q.why,
    suggestion: q.suggestion
  }))
}

/* ------------------------------------------------------------- the clip cut */

export interface CutOptions {
  recordingId: string
  answers: Array<{ question: string; answer: string }>
  platforms?: PlatformId[]
  maxClips?: number
}

export async function runCut(
  opts: CutOptions,
  onProgress: ProgressFn
): Promise<{ clips: number }> {
  const s = getSettings()
  const rec = await repo.getRecording(opts.recordingId)
  if (!rec) throw NotFoundError('Recording')
  if (!rec.duration_ms || rec.duration_ms < 10000) {
    throw MediaTooShortError(`recording is ${rec.duration_ms ?? 0}ms`)
  }

  const transcript = await repo.getTranscript(opts.recordingId)
  if (!transcript || transcript.segments.length === 0) {
    throw NotFoundError('Transcript (run transcription first)')
  }

  if (opts.answers.length > 0) await repo.saveAnswers(opts.recordingId, opts.answers)
  const storedAnswers = await repo.getAnswers(opts.recordingId)

  const platforms = opts.platforms?.length ? opts.platforms : s.platforms
  const maxClips = opts.maxClips ?? s.maxClips
  const segments = transcript.segments.map((x) => ({
    startMs: x.start_ms,
    endMs: x.end_ms,
    text: x.text
  }))

  onProgress('Planning clips', 0.05)
  const prompt = fillTemplate(s.promptClipPlan, {
    title: rec.title,
    duration: (rec.duration_ms / 1000).toFixed(1),
    context: await projectContext(opts.recordingId),
    answers: storedAnswers.length
      ? 'THE BUILDER ANSWERED:\n' +
        storedAnswers.map((a) => `Q: ${a.question}\nA: ${a.answer}`).join('\n')
      : '',
    transcript: formatTranscript(segments),
    platforms: describePlatforms(platforms),
    maxClips: String(maxClips)
  })

  const { text, provider } = await complete(
    { prompt, system: 'You output raw JSON and nothing else.', temperature: 0.5, maxTokens: 8000 },
    s.llmProvider,
    llmConfig(s)
  )
  log.info('pipeline', 'clip plan received', { provider, chars: text.length })

  const planned = parseClipPlan(text, {
    durationMs: rec.duration_ms,
    segments,
    allowedPlatforms: platforms,
    maxClips
  })

  if (planned.length === 0) {
    log.warn('pipeline', 'model found no clip-worthy moments', { recordingId: opts.recordingId })
    await repo.replaceClips(opts.recordingId, [])
    return { clips: 0 }
  }

  const created = await repo.replaceClips(opts.recordingId, planned)
  await renderAll(opts.recordingId, created, planned, onProgress)
  await indexRecording(opts.recordingId)
  return { clips: created.length }
}

async function renderAll(
  recordingId: string,
  created: Array<{ id: string }>,
  planned: ValidatedClip[],
  onProgress: ProgressFn
): Promise<void> {
  const s = getSettings()
  const rec = await repo.getRecording(recordingId)
  if (!rec) throw NotFoundError('Recording')

  const screen = await repo.getTrack(recordingId, 'screen')
  const webcam = await repo.getTrack(recordingId, 'webcam')
  const transcript = await repo.getTranscript(recordingId)
  if (!screen) throw NotFoundError('Screen track')

  const clipsDir = join(rec.dir, 'clips')
  mkdirSync(clipsDir, { recursive: true })

  for (let i = 0; i < planned.length; i++) {
    const p = planned[i]
    const row = created[i]
    const base = 0.15 + (i / planned.length) * 0.8
    const span = 0.8 / planned.length

    onProgress(`Rendering clip ${i + 1} of ${planned.length} (${p.platform})`, base)

    const cues = transcript
      ? cuesForWindow(
          transcript.segments.map((x) => ({
            start_ms: x.start_ms,
            end_ms: x.end_ms,
            text: x.text
          })),
          p.startMs,
          p.endMs
        )
      : []

    const outPath = join(clipsDir, `${slugify(p.title) || 'clip'}-${p.platform}-${i + 1}.mp4`)

    // One clip failing must not lose the other clips or the whole cut. Record
    // the failure and keep going.
    try {
      const res = await renderClip({
        masterPath: screen.path,
        webcamPath: webcam?.path ?? null,
        outputPath: outPath,
        startMs: p.startMs,
        endMs: p.endMs,
        platform: p.platform,
        captions: cues,
        burnCaptions: s.burnCaptions,
        webcamPip: s.webcamPip,
        onProgress: (f) => onProgress(`Rendering clip ${i + 1} of ${planned.length}`, base + f * span)
      })

      let poster: string | null = null
      try {
        poster = await posterFrame(res.path, outPath.replace(/\.mp4$/, '.jpg'), 0.5, 480)
      } catch (e) {
        log.warn('pipeline', 'poster frame failed, clip is still fine', {
          clip: row.id,
          error: String(e)
        })
      }

      await repo.addRender(row.id, {
        path: res.path,
        posterPath: poster,
        width: res.width,
        height: res.height,
        durationMs: res.durationMs,
        bytes: res.bytes,
        captions: s.burnCaptions && cues.length > 0,
        webcamPip: s.webcamPip && Boolean(webcam)
      })
    } catch (e) {
      log.error('pipeline', 'clip render failed', {
        clip: row.id,
        platform: p.platform,
        error: serializeError(e).message,
        detail: serializeError(e).detail.slice(0, 800)
      })
    }
  }
}

export function slugify(s: string): string {
  return s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 48)
}

/* --------------------------------------------------------------- re-render */

export async function reRenderClip(clipId: string, onProgress: ProgressFn): Promise<void> {
  const s = getSettings()
  const clip = await repo.getClip(clipId)
  if (!clip) throw NotFoundError('Clip')
  const rec = await repo.getRecording(clip.recording_id)
  if (!rec) throw NotFoundError('Recording')
  const screen = await repo.getTrack(clip.recording_id, 'screen')
  const webcam = await repo.getTrack(clip.recording_id, 'webcam')
  if (!screen) throw NotFoundError('Screen track')
  const transcript = await repo.getTranscript(clip.recording_id)

  const cues = transcript
    ? cuesForWindow(
        transcript.segments.map((x) => ({
          start_ms: x.start_ms,
          end_ms: x.end_ms,
          text: x.text
        })),
        clip.start_ms,
        clip.end_ms
      )
    : []

  const clipsDir = join(rec.dir, 'clips')
  mkdirSync(clipsDir, { recursive: true })
  const outPath = join(clipsDir, `${slugify(clip.title) || 'clip'}-${clip.platform}-${clip.rank + 1}.mp4`)

  onProgress('Re-rendering', 0.1)
  const res = await renderClip({
    masterPath: screen.path,
    webcamPath: webcam?.path ?? null,
    outputPath: outPath,
    startMs: clip.start_ms,
    endMs: clip.end_ms,
    platform: clip.platform,
    captions: cues,
    burnCaptions: s.burnCaptions,
    webcamPip: s.webcamPip,
    onProgress: (f) => onProgress('Re-rendering', 0.1 + f * 0.85)
  })

  let poster: string | null = null
  try {
    poster = await posterFrame(res.path, outPath.replace(/\.mp4$/, '.jpg'), 0.5, 480)
  } catch {
    poster = null
  }

  await repo.addRender(clipId, {
    path: res.path,
    posterPath: poster,
    width: res.width,
    height: res.height,
    durationMs: res.durationMs,
    bytes: res.bytes,
    captions: s.burnCaptions && cues.length > 0,
    webcamPip: s.webcamPip && Boolean(webcam)
  })
}

/* --------------------------------------------------------------- notebook */

export async function generateNotes(recordingId: string): Promise<{ title: string; body: string }> {
  const s = getSettings()
  const transcript = await repo.getTranscript(recordingId)
  if (!transcript || transcript.segments.length === 0) throw NotFoundError('Transcript')

  const prompt = fillTemplate(s.promptNotes, {
    context: await projectContext(recordingId),
    transcript: formatTranscript(
      transcript.segments.map((x) => ({ startMs: x.start_ms, endMs: x.end_ms, text: x.text })),
      40000
    )
  })

  const { text } = await complete(
    { prompt, system: 'You output raw JSON and nothing else.', temperature: 0.3, maxTokens: 3000 },
    s.llmProvider,
    llmConfig(s)
  )

  const parsed = notesSchema.safeParse(extractJson(text) ?? {})
  if (!parsed.success) {
    // Never lose the model's work: fall back to its raw prose as the note body.
    const body = text.trim()
    const note = await repo.upsertRecordingNote(recordingId, 'Session notes', body)
    return { title: note.title, body: note.body }
  }

  const n = parsed.data
  const lines: string[] = []
  if (n.summary) lines.push(n.summary, '')
  if (n.bullets.length) {
    lines.push('## What happened', ...n.bullets.map((b) => `- ${b}`), '')
  }
  if (n.todos.length) {
    lines.push('## Next', ...n.todos.map((t) => `- [ ] ${t}`), '')
  }
  const body = lines.join('\n').trim()
  const title = n.title || 'Session notes'

  await repo.upsertRecordingNote(recordingId, title, body)
  if (n.tags.length) await repo.setRecordingTags(recordingId, n.tags)
  return { title, body }
}

/* -------------------------------------------------------------- knowledge */

/**
 * Chunks the transcript and clip text into the embeddings table. Runs after a
 * cut so the archive is searchable the moment a recording is processed, not on
 * some later sweep the user never triggers.
 */
export async function indexRecording(recordingId: string): Promise<{ chunks: number }> {
  const transcript = await repo.getTranscript(recordingId)
  const clips = await repo.listClips(recordingId)
  const note = await repo.getRecordingNote(recordingId)

  await repo.clearEmbeddings(recordingId)

  const chunks: Array<{ kind: string; refId: string | null; text: string; startMs: number | null; endMs: number | null }> = []

  if (transcript) {
    // ~45s windows: long enough to hold an idea, short enough to point at a moment.
    let buf: typeof transcript.segments = []
    const flush = (): void => {
      if (buf.length === 0) return
      chunks.push({
        kind: 'segment',
        refId: null,
        text: buf.map((s) => s.text).join(' '),
        startMs: buf[0].start_ms,
        endMs: buf[buf.length - 1].end_ms
      })
      buf = []
    }
    for (const seg of transcript.segments) {
      buf.push(seg)
      if (buf[buf.length - 1].end_ms - buf[0].start_ms >= 45000) flush()
    }
    flush()
  }

  for (const c of clips) {
    chunks.push({
      kind: 'clip',
      refId: c.id,
      text: `${c.title}\n${c.hook}\n${c.description}`,
      startMs: c.start_ms,
      endMs: c.end_ms
    })
  }
  if (note?.body) {
    chunks.push({ kind: 'note', refId: note.id, text: `${note.title}\n${note.body}`, startMs: null, endMs: null })
  }

  if (chunks.length === 0) return { chunks: 0 }

  // Embeddings are optional: without a local embedder the text index still
  // makes everything searchable, so a missing model degrades, never blocks.
  const vectors = await embedTexts(chunks.map((c) => c.text))

  for (let i = 0; i < chunks.length; i++) {
    const c = chunks[i]
    await repo.saveEmbedding(recordingId, c.kind, c.refId, c.text, c.startMs, c.endMs, vectors[i] ?? null)
  }
  log.info('pipeline', 'indexed recording', {
    recordingId,
    chunks: chunks.length,
    embedded: vectors.filter(Boolean).length
  })
  return { chunks: chunks.length }
}

export async function search(q: string): Promise<repo.SearchHit[]> {
  const [vec] = await embedTexts([q])
  return repo.searchKnowledge(q, vec ?? null)
}

export { probe }
