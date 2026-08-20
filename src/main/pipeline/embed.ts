import { getSettings, resolveKey } from '../settings.ts'
import { log } from '../log.ts'

const DIM = 768

/**
 * Embeddings are a nice-to-have, never a gate. If nothing local or remote is
 * available we return nulls and the knowledgebase falls back to the Postgres
 * full-text index, which still finds everything by keyword.
 *
 * 768 dimensions to match the schema — nomic-embed-text is exactly 768, and
 * anything else gets truncated or zero-padded to fit rather than failing.
 */
export async function embedTexts(texts: string[]): Promise<Array<number[] | null>> {
  if (texts.length === 0) return []
  const s = getSettings()

  const viaOllama = await tryOllama(texts, s.ollamaBaseUrl)
  if (viaOllama) return viaOllama

  const openaiKey = resolveKey('openai')
  if (openaiKey) {
    const viaOpenAi = await tryOpenAi(texts, openaiKey)
    if (viaOpenAi) return viaOpenAi
  }

  log.info('embed', 'no embedding provider available, using text search only')
  return texts.map(() => null)
}

function fit(vec: number[]): number[] {
  if (vec.length === DIM) return vec
  if (vec.length > DIM) return vec.slice(0, DIM)
  return [...vec, ...new Array(DIM - vec.length).fill(0)]
}

async function tryOllama(texts: string[], baseUrl: string): Promise<Array<number[] | null> | null> {
  const base = baseUrl || 'http://127.0.0.1:11434'
  let model = ''
  try {
    const controller = new AbortController()
    const t = setTimeout(() => controller.abort(), 1500)
    const res = await fetch(`${base}/api/tags`, { signal: controller.signal })
    clearTimeout(t)
    if (!res.ok) return null
    const data = (await res.json()) as { models?: Array<{ name: string }> }
    const names = (data.models ?? []).map((m) => m.name)
    model =
      names.find((n) => n.startsWith('nomic-embed-text')) ??
      names.find((n) => n.includes('embed')) ??
      ''
    if (!model) return null
  } catch {
    return null
  }

  try {
    const out: Array<number[] | null> = []
    for (const text of texts) {
      const res = await fetch(`${base}/api/embeddings`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ model, prompt: text.slice(0, 8000) })
      })
      if (!res.ok) return null
      const data = (await res.json()) as { embedding?: number[] }
      out.push(data.embedding ? fit(data.embedding) : null)
    }
    log.info('embed', 'embedded with ollama', { model, count: out.length })
    return out
  } catch (e) {
    log.warn('embed', 'ollama embedding failed', { error: String(e) })
    return null
  }
}

async function tryOpenAi(texts: string[], apiKey: string): Promise<Array<number[] | null> | null> {
  try {
    const res = await fetch('https://api.openai.com/v1/embeddings', {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${apiKey}` },
      body: JSON.stringify({
        model: 'text-embedding-3-small',
        input: texts.map((t) => t.slice(0, 8000)),
        dimensions: DIM
      })
    })
    if (!res.ok) return null
    const data = (await res.json()) as { data?: Array<{ embedding: number[] }> }
    if (!data.data) return null
    log.info('embed', 'embedded with openai', { count: data.data.length })
    return data.data.map((d) => fit(d.embedding))
  } catch (e) {
    log.warn('embed', 'openai embedding failed', { error: String(e) })
    return null
  }
}
