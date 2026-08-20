export type PlatformId = 'x' | 'linkedin' | 'youtube_short' | 'youtube'

export interface PlatformSpec {
  id: PlatformId
  label: string
  /** Target output pixel dimensions. */
  width: number
  height: number
  /** Hard ceiling the renderer clamps clip length to, in seconds. */
  maxSeconds: number
  /** Soft target the LLM aims for, in seconds. */
  idealSeconds: [number, number]
  /** Character ceiling for the post body. */
  maxChars: number
  /** How the source frame is fitted into the target box. */
  fit: 'crop' | 'pad'
  hint: string
}

export const PLATFORMS: Record<PlatformId, PlatformSpec> = {
  x: {
    id: 'x',
    label: 'X',
    width: 1280,
    height: 720,
    maxSeconds: 140,
    idealSeconds: [20, 90],
    maxChars: 270,
    fit: 'pad',
    hint: 'Punchy. One idea. Hook in the first line. No hashtag spam.'
  },
  linkedin: {
    id: 'linkedin',
    label: 'LinkedIn',
    width: 1080,
    height: 1080,
    maxSeconds: 600,
    idealSeconds: [45, 180],
    maxChars: 1300,
    fit: 'pad',
    hint: 'Lead with the problem, then what you built. Short paragraphs, line breaks between them. Professional but human, never corporate.'
  },
  youtube_short: {
    id: 'youtube_short',
    label: 'YouTube Short',
    width: 1080,
    height: 1920,
    maxSeconds: 60,
    idealSeconds: [20, 55],
    maxChars: 380,
    fit: 'pad',
    hint: 'Vertical. Hook in the first 2 seconds or it is scrolled past. Title under 60 chars.'
  },
  youtube: {
    id: 'youtube',
    label: 'YouTube',
    width: 1920,
    height: 1080,
    maxSeconds: 3600,
    idealSeconds: [120, 900],
    maxChars: 4500,
    fit: 'pad',
    hint: 'Descriptive title with the concrete thing built. Description with a short summary then timestamps.'
  }
}

export const PLATFORM_IDS = Object.keys(PLATFORMS) as PlatformId[]
