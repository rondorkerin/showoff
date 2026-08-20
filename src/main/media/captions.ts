export interface CaptionCue {
  startMs: number
  endMs: number
  text: string
}

/** ASS needs braces and backslashes escaped, and hard line breaks as \N. */
function escapeAss(text: string): string {
  return text
    .replace(/\\/g, '\\\\')
    .replace(/\{/g, '\\{')
    .replace(/\}/g, '\\}')
    .trim()
}

function assTime(ms: number): string {
  const clamped = Math.max(0, ms)
  const cs = Math.floor((clamped % 1000) / 10)
  const totalSec = Math.floor(clamped / 1000)
  const s = totalSec % 60
  const m = Math.floor(totalSec / 60) % 60
  const h = Math.floor(totalSec / 3600)
  const p = (n: number, w = 2): string => String(n).padStart(w, '0')
  return `${h}:${p(m)}:${p(s)}.${p(cs)}`
}

/** Greedy word wrap into lines of at most maxChars. */
function wrapLines(text: string, maxChars: number): string[] {
  const words = text.split(/\s+/).filter(Boolean)
  const lines: string[] = []
  let current = ''
  for (const w of words) {
    if (current.length === 0) current = w
    else if ((current + ' ' + w).length <= maxChars) current += ' ' + w
    else {
      lines.push(current)
      current = w
    }
  }
  if (current) lines.push(current)
  return lines
}

/**
 * A transcript segment can be far longer than fits on screen. Rather than
 * truncating it (which silently drops words the person actually said), split it
 * into consecutive on-screen cards and divide the segment's duration between
 * them in proportion to their length.
 */
export function splitCue(cue: CaptionCue, maxChars: number, maxLines: number): CaptionCue[] {
  const lines = wrapLines(cue.text, maxChars)
  if (lines.length === 0) return []

  const cards: string[] = []
  for (let i = 0; i < lines.length; i += maxLines) {
    cards.push(lines.slice(i, i + maxLines).join('\n'))
  }
  if (cards.length === 1) return [{ ...cue, text: cards[0] }]

  const total = cards.reduce((n, c) => n + c.length, 0) || 1
  const span = Math.max(1, cue.endMs - cue.startMs)
  const out: CaptionCue[] = []
  let cursor = cue.startMs
  cards.forEach((card, i) => {
    const share = Math.round((card.length / total) * span)
    const start = cursor
    // Last card always lands exactly on the segment end so nothing drifts.
    const end = i === cards.length - 1 ? cue.endMs : Math.min(cue.endMs, start + share)
    if (end > start) out.push({ startMs: start, endMs: end, text: card })
    cursor = end
  })
  return out
}

export interface CaptionStyle {
  width: number
  height: number
  /** Vertical formats need tighter lines and more bottom margin to clear platform UI. */
  vertical: boolean
}

export function buildAss(cues: CaptionCue[], style: CaptionStyle): string {
  const fontSize = Math.round(style.height * (style.vertical ? 0.036 : 0.05))
  const marginV = Math.round(style.height * (style.vertical ? 0.18 : 0.07))
  const marginH = Math.round(style.width * 0.08)
  const outline = Math.max(2, Math.round(fontSize * 0.11))
  const maxChars = style.vertical ? 20 : 34
  const maxLines = 2

  // WrapStyle 0 (libass smart wrapping) is the safety net under our own
  // wrapping: verified visually that WrapStyle 2 renders an over-long line
  // clipped off both edges of the frame instead of wrapping it.
  const header = `[Script Info]
ScriptType: v4.00+
PlayResX: ${style.width}
PlayResY: ${style.height}
WrapStyle: 0
ScaledBorderAndShadow: yes

[V4+ Styles]
Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding
Style: Showoff,Arial,${fontSize},&H00FFFFFF,&H00FFFFFF,&H00000000,&H80000000,-1,0,0,0,100,100,0,0,1,${outline},1,2,${marginH},${marginH},${marginV},1

[Events]
Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text`

  const events = cues
    .filter((c) => c.endMs > c.startMs && c.text.trim().length > 0)
    .flatMap((c) => splitCue(c, maxChars, maxLines))
    .map(
      (c) =>
        `Dialogue: 0,${assTime(c.startMs)},${assTime(c.endMs)},Showoff,,0,0,0,,${escapeAss(
          c.text
        ).replace(/\r?\n/g, '\\N')}`
    )

  return `${header}\n${events.join('\n')}\n`
}

/**
 * Slice transcript segments down to a clip window and rebase their timings to
 * zero. Segments straddling the boundary are kept and clamped, because dropping
 * them silently loses the first spoken words of a clip.
 */
export function cuesForWindow(
  segments: Array<{ start_ms: number; end_ms: number; text: string }>,
  startMs: number,
  endMs: number
): CaptionCue[] {
  return segments
    .filter((s) => s.end_ms > startMs && s.start_ms < endMs)
    .map((s) => ({
      startMs: Math.max(0, s.start_ms - startMs),
      endMs: Math.min(endMs - startMs, s.end_ms - startMs),
      text: s.text
    }))
    .filter((c) => c.endMs > c.startMs)
}
