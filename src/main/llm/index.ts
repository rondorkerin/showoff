import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { LlmRequestError, LlmUnavailableError } from '../../shared/errors.ts'
import type { ProviderStatus } from '../../shared/types.ts'
import { log } from '../log.ts'

export interface LlmRequest {
  prompt: string
  system?: string
  maxTokens?: number
  temperature?: number
}

export interface LlmProvider {
  id: string
  label: string
  /** Cheap check — must not make a paid call. */
  available(cfg: LlmConfig): Promise<{ ok: boolean; detail: string }>
  complete(req: LlmRequest, cfg: LlmConfig): Promise<string>
}

export interface LlmConfig {
  anthropicApiKey: string
  openaiApiKey: string
  ollamaBaseUrl: string
  ollamaModel: string
  customBaseUrl: string
  customApiKey: string
  customModel: string
  model: string
}

const DEFAULT_ANTHROPIC_MODEL = 'claude-sonnet-5'
const DEFAULT_OPENAI_MODEL = 'gpt-4o-mini'

async function fetchJson(
  url: string,
  init: RequestInit,
  timeoutMs = 180_000
): Promise<Record<string, unknown>> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  try {
    const res = await fetch(url, { ...init, signal: controller.signal })
    const text = await res.text()
    if (!res.ok) {
      throw LlmRequestError(`${url} returned ${res.status}: ${text.slice(0, 1200)}`)
    }
    try {
      return JSON.parse(text) as Record<string, unknown>
    } catch {
      throw LlmRequestError(`${url} returned non-JSON: ${text.slice(0, 600)}`)
    }
  } catch (e) {
    if (e instanceof Error && e.name === 'AbortError') {
      throw LlmRequestError(`${url} timed out after ${Math.round(timeoutMs / 1000)}s`)
    }
    throw e
  } finally {
    clearTimeout(timer)
  }
}

/**
 * Finds the `claude` CLI. This is the zero-configuration path: anyone who has
 * Claude Code installed already has working auth, so Showoff can plan clips
 * without asking for an API key at all.
 */
function findClaudeCli(): string | null {
  const candidates = [
    process.env.CLAUDE_CLI_PATH,
    join(process.env.HOME ?? '', '.local/bin/claude'),
    '/usr/local/bin/claude',
    '/opt/homebrew/bin/claude',
    join(process.env.HOME ?? '', '.claude/local/claude')
  ].filter(Boolean) as string[]

  for (const c of candidates) if (existsSync(c)) return c
  return null
}

function runCli(bin: string, args: string[], input: string, timeoutMs = 240_000): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(bin, args, { windowsHide: true, env: { ...process.env } })
    let stdout = ''
    let stderr = ''
    const timer = setTimeout(() => {
      child.kill('SIGKILL')
      reject(LlmRequestError(`${bin} timed out after ${Math.round(timeoutMs / 1000)}s`))
    }, timeoutMs)

    child.stdout.on('data', (d: Buffer) => (stdout += d.toString()))
    child.stderr.on('data', (d: Buffer) => (stderr += d.toString()))
    child.on('error', (e) => {
      clearTimeout(timer)
      reject(LlmRequestError(`could not start ${bin}: ${e.message}`))
    })
    child.on('close', (code) => {
      clearTimeout(timer)
      if (code === 0) return resolve(stdout)
      reject(LlmRequestError(`${bin} exited ${code}: ${stderr.slice(-1500)}`))
    })
    child.stdin.end(input)
  })
}

export const claudeCliProvider: LlmProvider = {
  id: 'claude-cli',
  label: 'Claude CLI (no API key needed)',
  async available() {
    const bin = findClaudeCli()
    return bin
      ? { ok: true, detail: `using ${bin}` }
      : { ok: false, detail: 'claude CLI not found on this machine' }
  },
  async complete(req) {
    const bin = findClaudeCli()
    if (!bin) throw LlmUnavailableError('claude CLI not found')
    const args = ['-p', '--output-format', 'text']
    if (req.system) args.push('--append-system-prompt', req.system)
    // Prompt goes over stdin so a long transcript never hits an argv limit.
    return runCli(bin, args, req.prompt)
  }
}

export const anthropicProvider: LlmProvider = {
  id: 'anthropic',
  label: 'Anthropic API',
  async available(cfg) {
    return cfg.anthropicApiKey
      ? { ok: true, detail: 'API key set' }
      : { ok: false, detail: 'no ANTHROPIC_API_KEY' }
  },
  async complete(req, cfg) {
    if (!cfg.anthropicApiKey) throw LlmUnavailableError('no Anthropic API key')
    const body = await fetchJson('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-api-key': cfg.anthropicApiKey,
        'anthropic-version': '2023-06-01'
      },
      body: JSON.stringify({
        model: cfg.model || DEFAULT_ANTHROPIC_MODEL,
        max_tokens: req.maxTokens ?? 4096,
        temperature: req.temperature ?? 0.4,
        system: req.system,
        messages: [{ role: 'user', content: req.prompt }]
      })
    })
    const content = (body.content as Array<{ type: string; text?: string }> | undefined) ?? []
    return content
      .filter((c) => c.type === 'text')
      .map((c) => c.text ?? '')
      .join('')
  }
}

/** Shared shape for every OpenAI-compatible endpoint: OpenAI, Ollama, custom. */
async function openAiCompatible(
  req: LlmRequest,
  baseUrl: string,
  apiKey: string,
  model: string
): Promise<string> {
  const messages: Array<{ role: string; content: string }> = []
  if (req.system) messages.push({ role: 'system', content: req.system })
  messages.push({ role: 'user', content: req.prompt })

  const headers: Record<string, string> = { 'content-type': 'application/json' }
  if (apiKey) headers.authorization = `Bearer ${apiKey}`

  const body = await fetchJson(`${baseUrl.replace(/\/$/, '')}/chat/completions`, {
    method: 'POST',
    headers,
    body: JSON.stringify({
      model,
      messages,
      temperature: req.temperature ?? 0.4,
      max_tokens: req.maxTokens ?? 4096
    })
  })
  const choices = body.choices as Array<{ message?: { content?: string } }> | undefined
  return choices?.[0]?.message?.content ?? ''
}

export const openaiProvider: LlmProvider = {
  id: 'openai',
  label: 'OpenAI API',
  async available(cfg) {
    return cfg.openaiApiKey
      ? { ok: true, detail: 'API key set' }
      : { ok: false, detail: 'no OPENAI_API_KEY' }
  },
  async complete(req, cfg) {
    if (!cfg.openaiApiKey) throw LlmUnavailableError('no OpenAI API key')
    return openAiCompatible(
      req,
      'https://api.openai.com/v1',
      cfg.openaiApiKey,
      cfg.model || DEFAULT_OPENAI_MODEL
    )
  }
}

export const ollamaProvider: LlmProvider = {
  id: 'ollama',
  label: 'Ollama (local)',
  async available(cfg) {
    const base = cfg.ollamaBaseUrl || 'http://127.0.0.1:11434'
    try {
      const controller = new AbortController()
      const t = setTimeout(() => controller.abort(), 1500)
      const res = await fetch(`${base}/api/tags`, { signal: controller.signal })
      clearTimeout(t)
      if (!res.ok) return { ok: false, detail: `ollama returned ${res.status}` }
      const data = (await res.json()) as { models?: Array<{ name: string }> }
      const names = (data.models ?? []).map((m) => m.name)
      if (names.length === 0) return { ok: false, detail: 'ollama is running but has no models' }
      return { ok: true, detail: names.slice(0, 4).join(', ') }
    } catch {
      return { ok: false, detail: `not reachable at ${base}` }
    }
  },
  async complete(req, cfg) {
    const base = cfg.ollamaBaseUrl || 'http://127.0.0.1:11434'
    let model = cfg.ollamaModel
    if (!model) {
      const res = await fetch(`${base}/api/tags`)
      const data = (await res.json()) as { models?: Array<{ name: string }> }
      model = data.models?.[0]?.name ?? ''
    }
    if (!model) throw LlmUnavailableError('ollama has no models installed')
    return openAiCompatible(req, `${base}/v1`, '', model)
  }
}

export const customProvider: LlmProvider = {
  id: 'custom',
  label: 'Custom OpenAI-compatible endpoint',
  async available(cfg) {
    return cfg.customBaseUrl && cfg.customModel
      ? { ok: true, detail: cfg.customBaseUrl }
      : { ok: false, detail: 'set a base URL and model in Settings' }
  },
  async complete(req, cfg) {
    if (!cfg.customBaseUrl) throw LlmUnavailableError('no custom base URL')
    return openAiCompatible(req, cfg.customBaseUrl, cfg.customApiKey, cfg.customModel)
  }
}

/** Cheapest-thing-that-already-works order. */
export const LLM_PROVIDERS: LlmProvider[] = [
  claudeCliProvider,
  anthropicProvider,
  openaiProvider,
  ollamaProvider,
  customProvider
]

export async function llmStatuses(cfg: LlmConfig): Promise<ProviderStatus[]> {
  return Promise.all(
    LLM_PROVIDERS.map(async (p) => {
      const r = await p.available(cfg).catch((e) => ({ ok: false, detail: String(e) }))
      return { id: p.id, label: p.label, available: r.ok, detail: r.detail }
    })
  )
}

export async function resolveLlm(preferred: string, cfg: LlmConfig): Promise<LlmProvider> {
  if (preferred && preferred !== 'auto') {
    const p = LLM_PROVIDERS.find((x) => x.id === preferred)
    if (!p) throw LlmUnavailableError(`unknown provider "${preferred}"`)
    const r = await p.available(cfg)
    if (!r.ok) throw LlmUnavailableError(`${p.label} is not usable: ${r.detail}`)
    return p
  }
  for (const p of LLM_PROVIDERS) {
    const r = await p.available(cfg).catch(() => ({ ok: false, detail: '' }))
    if (r.ok) {
      log.info('llm', 'auto-selected provider', { provider: p.id, detail: r.detail })
      return p
    }
  }
  throw LlmUnavailableError('no provider is configured or reachable')
}

export async function complete(
  req: LlmRequest,
  preferred: string,
  cfg: LlmConfig
): Promise<{ text: string; provider: string }> {
  const provider = await resolveLlm(preferred, cfg)
  const started = Date.now()
  const text = await provider.complete(req, cfg)
  log.info('llm', 'completion done', {
    provider: provider.id,
    ms: Date.now() - started,
    chars: text.length
  })
  if (!text.trim()) {
    throw LlmRequestError(`${provider.label} returned an empty response`)
  }
  return { text, provider: provider.id }
}
