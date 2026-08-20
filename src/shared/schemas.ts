import { z } from 'zod'
import { PLATFORM_IDS } from './platforms.ts'

/**
 * Everything an LLM hands back crosses this boundary. Nothing downstream is
 * allowed to assume shape — if the model improvises, we fail loudly with the
 * raw text attached rather than rendering garbage.
 */

export const clarifyingQuestionSchema = z.object({
  question: z.string().min(3).max(300),
  why: z.string().max(300).default(''),
  suggestion: z.string().max(300).default('')
})

export const clarifyingQuestionsSchema = z.object({
  questions: z.array(clarifyingQuestionSchema).max(6).default([])
})

export const plannedClipSchema = z.object({
  platform: z.enum(PLATFORM_IDS as [string, ...string[]]),
  title: z.string().min(1).max(200),
  hook: z.string().max(300).default(''),
  description: z.string().max(6000).default(''),
  hashtags: z.array(z.string().max(60)).max(12).default([]),
  reason: z.string().max(600).default(''),
  score: z.coerce.number().min(0).max(10).default(5),
  start_seconds: z.coerce.number().min(0),
  end_seconds: z.coerce.number().min(0)
})

/**
 * Deliberately loose at the top level: the individual clips are validated one
 * at a time so that a single malformed entry drops that clip rather than
 * throwing away an otherwise good plan.
 */
export const clipPlanSchema = z.object({
  clips: z.array(z.unknown()).max(60).default([])
})

export const notesSchema = z.object({
  title: z.string().max(200).default(''),
  summary: z.string().max(4000).default(''),
  bullets: z.array(z.string().max(500)).max(30).default([]),
  todos: z.array(z.string().max(500)).max(30).default([]),
  tags: z.array(z.string().max(40)).max(15).default([])
})

export type PlannedClip = z.infer<typeof plannedClipSchema>
export type ClipPlan = z.infer<typeof clipPlanSchema>
export type NotesResult = z.infer<typeof notesSchema>

/**
 * Models like to wrap JSON in prose or fences. Pull the first balanced JSON
 * object out of a blob of text. Returns null rather than throwing so callers
 * can attach the original text to the error they raise.
 */
export function extractJson(raw: string): unknown | null {
  const text = raw.trim()
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/)
  const candidates = [fenced?.[1], text].filter(Boolean) as string[]

  for (const candidate of candidates) {
    const direct = tryParse(candidate)
    if (direct !== undefined) return direct

    const start = candidate.indexOf('{')
    if (start === -1) continue
    let depth = 0
    let inString = false
    let escaped = false
    for (let i = start; i < candidate.length; i++) {
      const ch = candidate[i]
      if (escaped) {
        escaped = false
        continue
      }
      if (ch === '\\') {
        escaped = true
        continue
      }
      if (ch === '"') inString = !inString
      if (inString) continue
      if (ch === '{') depth++
      if (ch === '}') {
        depth--
        if (depth === 0) {
          const parsed = tryParse(candidate.slice(start, i + 1))
          if (parsed !== undefined) return parsed
          break
        }
      }
    }
  }
  return null
}

function tryParse(s: string): unknown | undefined {
  try {
    return JSON.parse(s)
  } catch {
    return undefined
  }
}
