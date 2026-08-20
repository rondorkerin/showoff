import { clipPlanSchema, extractJson, plannedClipSchema, type PlannedClip } from '../../shared/schemas.ts'
import { LlmSchemaError } from '../../shared/errors.ts'
import { PLATFORMS, type PlatformId } from '../../shared/platforms.ts'
import type { Segment } from '../transcribe/index.ts'
import { log } from '../log.ts'

export interface ValidatedClip {
  platform: PlatformId
  title: string
  hook: string
  description: string
  hashtags: string[]
  reason: string
  score: number
  startMs: number
  endMs: number
}

export const MIN_CLIP_MS = 8000

/**
 * Pull the plan out of a model response and make it safe to render.
 *
 * A model will confidently emit a clip that runs past the end of the video, or
 * starts mid-word, or lasts 1.2 seconds. Rendering those produces broken files
 * that look like the product is broken. Everything below is the guard rail.
 */
export function parseClipPlan(
  raw: string,
  opts: {
    durationMs: number
    segments: Segment[]
    allowedPlatforms: PlatformId[]
    maxClips: number
  }
): ValidatedClip[] {
  const json = extractJson(raw)
  if (json === null) {
    throw LlmSchemaError(`no JSON object found in the model response:\n\n${raw.slice(0, 1500)}`)
  }

  const parsed = clipPlanSchema.safeParse(json)
  if (!parsed.success) {
    throw LlmSchemaError(
      `clip plan did not match the expected shape: ${parsed.error.message}\n\n${raw.slice(0, 1500)}`
    )
  }

  const allowed = new Set(opts.allowedPlatforms)
  const clips: ValidatedClip[] = []
  let rejected = 0

  for (const entry of parsed.data.clips) {
    // Per-clip validation: one bad entry loses that clip, not the whole plan.
    const single = plannedClipSchema.safeParse(entry)
    if (!single.success) {
      rejected++
      continue
    }
    const c = single.data as PlannedClip
    const platform = c.platform as PlatformId
    if (!allowed.has(platform)) continue
    const spec = PLATFORMS[platform]
    if (!spec) continue

    let startMs = Math.round(c.start_seconds * 1000)
    let endMs = Math.round(c.end_seconds * 1000)

    // Models sometimes hand back the pair reversed.
    if (endMs < startMs) [startMs, endMs] = [endMs, startMs]

    startMs = clamp(startMs, 0, Math.max(0, opts.durationMs - 1000))
    endMs = clamp(endMs, 0, opts.durationMs)

    const snapped = snapToSegments(startMs, endMs, opts.segments)
    startMs = snapped.startMs
    endMs = snapped.endMs

    // Respect the platform ceiling by trimming the tail, not by dropping it.
    const maxMs = spec.maxSeconds * 1000
    if (endMs - startMs > maxMs) endMs = startMs + maxMs

    if (endMs - startMs < MIN_CLIP_MS) continue
    if (endMs > opts.durationMs) endMs = opts.durationMs
    if (endMs - startMs < MIN_CLIP_MS) continue

    clips.push({
      platform,
      title: c.title.trim().slice(0, 200),
      hook: c.hook.trim(),
      description: c.description.trim().slice(0, spec.maxChars),
      hashtags: c.hashtags.map((h) => h.replace(/^#/, '').trim()).filter(Boolean).slice(0, 8),
      reason: c.reason.trim(),
      score: clamp(c.score, 0, 10),
      startMs,
      endMs
    })
  }

  if (rejected > 0) {
    log.warn('plan', 'dropped malformed clips from the model response', {
      rejected,
      kept: clips.length
    })
  }
  // If *nothing* the model sent was even structurally a clip, that is a schema
  // failure and the user deserves to see the raw output. If some parsed fine
  // and were then filtered by the length and platform rules, an empty result is
  // the honest answer: this recording had no clip-worthy moments.
  if (rejected > 0 && rejected === parsed.data.clips.length) {
    throw LlmSchemaError(
      `all ${rejected} clips in the response were malformed:\n\n${raw.slice(0, 1500)}`
    )
  }

  const deduped = dedupe(clips)
  // Rank by the model's own honesty about what will perform. The UI shows the
  // best first, which is the whole defence against "20 mediocre clips".
  deduped.sort((a, b) => b.score - a.score)
  return deduped.slice(0, Math.max(1, opts.maxClips))
}

function clamp(n: number, lo: number, hi: number): number {
  if (!Number.isFinite(n)) return lo
  return Math.max(lo, Math.min(hi, n))
}

/**
 * Move clip boundaries onto transcript segment edges so a clip never starts or
 * ends mid-word. Only snaps when the nearest boundary is close, otherwise the
 * model's intent gets dragged somewhere it did not mean.
 */
export function snapToSegments(
  startMs: number,
  endMs: number,
  segments: Segment[],
  toleranceMs = 1200
): { startMs: number; endMs: number } {
  if (segments.length === 0) return { startMs, endMs }

  const starts = segments.map((s) => s.startMs)
  const ends = segments.map((s) => s.endMs)

  const nearestStart = nearest(starts, startMs)
  const nearestEnd = nearest(ends, endMs)

  return {
    startMs: Math.abs(nearestStart - startMs) <= toleranceMs ? nearestStart : startMs,
    endMs: Math.abs(nearestEnd - endMs) <= toleranceMs ? nearestEnd : endMs
  }
}

function nearest(values: number[], target: number): number {
  let best = values[0]
  let bestDist = Math.abs(values[0] - target)
  for (const v of values) {
    const d = Math.abs(v - target)
    if (d < bestDist) {
      best = v
      bestDist = d
    }
  }
  return best
}

/**
 * Two clips for the same platform covering nearly the same window are one clip.
 * The same window for *different* platforms is legitimate: that is the product.
 */
function dedupe(clips: ValidatedClip[]): ValidatedClip[] {
  const out: ValidatedClip[] = []
  for (const c of clips) {
    const clash = out.find(
      (o) =>
        o.platform === c.platform &&
        overlapFraction(o.startMs, o.endMs, c.startMs, c.endMs) > 0.8
    )
    if (!clash) {
      out.push(c)
      continue
    }
    if (c.score > clash.score) out[out.indexOf(clash)] = c
  }
  return out
}

export function overlapFraction(
  aStart: number,
  aEnd: number,
  bStart: number,
  bEnd: number
): number {
  const overlap = Math.max(0, Math.min(aEnd, bEnd) - Math.max(aStart, bStart))
  const shortest = Math.min(aEnd - aStart, bEnd - bStart)
  return shortest <= 0 ? 0 : overlap / shortest
}

/** Renders the transcript for the prompt: "[12.5-16.0] text" per line. */
export function formatTranscript(segments: Segment[], maxChars = 60000): string {
  const lines = segments.map(
    (s) => `[${(s.startMs / 1000).toFixed(1)}-${(s.endMs / 1000).toFixed(1)}] ${s.text}`
  )
  let out = lines.join('\n')
  if (out.length > maxChars) {
    // Keep the head and tail: openings and closings carry the most signal, and
    // a truncated middle is better than a truncated ending.
    const half = Math.floor(maxChars / 2)
    out = `${out.slice(0, half)}\n\n[... transcript truncated for length ...]\n\n${out.slice(-half)}`
  }
  return out
}

export function fillTemplate(template: string, vars: Record<string, string>): string {
  return template.replace(/\{\{(\w+)\}\}/g, (_, key: string) => vars[key] ?? '')
}

export function describePlatforms(ids: PlatformId[]): string {
  return ids
    .map((id) => {
      const p = PLATFORMS[id]
      return `- ${id} (${p.label}): ideal ${p.idealSeconds[0]}-${p.idealSeconds[1]}s, hard max ${p.maxSeconds}s, description up to ${p.maxChars} chars, ${p.width}x${p.height}. ${p.hint}`
    })
    .join('\n')
}
