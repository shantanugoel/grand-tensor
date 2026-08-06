/** Minimal OpenAI-compatible chat client. Works with OpenRouter, OpenAI, or any
 *  server exposing /chat/completions. No SDK — one fetch, one parse. */

import { NO_EFFORT } from './settings'

export type Usage = {
  prompt: number
  completion: number
  reasoning: number
  total: number
  /** USD, only if the provider reports it (OpenRouter does). */
  cost: number
}

export type ChatResult = { text: string; usage: Usage; ms: number; finish: string }

/** Dollars per token, as advertised by the endpoint's /models listing. */
export type Pricing = { prompt: number; completion: number }

/** What the endpoint says about a model. Every field is optional — plenty of
 *  OpenAI-compatible servers publish little more than an id. */
export type ModelInfo = {
  pricing?: Pricing
  /** Reasoning efforts this model actually accepts. Empty means "none offered". */
  efforts?: string[]
  /** What the provider uses when no effort is sent. */
  defaultEffort?: string
}

/** Offered when the endpoint says nothing about a model, so a custom server
 *  still lets you pick something rather than locking you to the default. */
export const FALLBACK_EFFORTS = ['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max']

export type ChatRequest = {
  baseUrl: string
  apiKey: string
  model: string
  temperature: number
  maxTokens: number
  messages: { role: 'system' | 'user' | 'assistant'; content: string }[]
  /** Used to derive a cost when the response doesn't report one itself. */
  pricing?: Pricing
  /** Sent verbatim; the caller is responsible for it being one the model takes. */
  effort: string
  signal?: AbortSignal
}

export const emptyUsage = (): Usage => ({ prompt: 0, completion: 0, reasoning: 0, total: 0, cost: 0 })

export function addUsage(a: Usage, b: Usage): Usage {
  return {
    prompt: a.prompt + b.prompt,
    completion: a.completion + b.completion,
    reasoning: a.reasoning + b.reasoning,
    total: a.total + b.total,
    cost: a.cost + b.cost,
  }
}

const trimUrl = (u: string) => u.replace(/\/+$/, '')
const isOpenRouter = (u: string) => /openrouter\.ai/i.test(u)

function headers(req: { baseUrl: string; apiKey: string }): Record<string, string> {
  const h: Record<string, string> = { 'Content-Type': 'application/json' }
  if (req.apiKey) h['Authorization'] = `Bearer ${req.apiKey}`
  if (isOpenRouter(req.baseUrl)) h['X-Title'] = 'Grand Tensor'
  return h
}

export async function chat(req: ChatRequest): Promise<ChatResult> {
  const body: Record<string, unknown> = {
    model: req.model,
    messages: req.messages,
    temperature: req.temperature,
    max_tokens: req.maxTokens,
  }

  if (req.effort !== NO_EFFORT) {
    // OpenRouter normalises effort under `reasoning`; plain OpenAI uses a flat field.
    if (isOpenRouter(req.baseUrl)) body.reasoning = { effort: req.effort }
    else body.reasoning_effort = req.effort
  }
  if (isOpenRouter(req.baseUrl)) body.usage = { include: true }

  const started = performance.now()
  const res = await fetch(`${trimUrl(req.baseUrl)}/chat/completions`, {
    method: 'POST',
    headers: headers(req),
    body: JSON.stringify(body),
    signal: req.signal,
  })
  const ms = performance.now() - started

  const raw = await res.text()
  let json: any
  try {
    json = JSON.parse(raw)
  } catch {
    throw new Error(`HTTP ${res.status}: ${raw.slice(0, 200)}`)
  }
  if (!res.ok || json.error) {
    const msg = json?.error?.message ?? json?.message ?? raw.slice(0, 200)
    throw new Error(`HTTP ${res.status}: ${msg}`)
  }

  const choice = json.choices?.[0] ?? {}
  const message = choice.message ?? {}
  const text: string = (message.content || message.reasoning || '').toString()
  const u = json.usage ?? {}
  const prompt = u.prompt_tokens ?? 0
  const completion = u.completion_tokens ?? 0

  return {
    text,
    ms,
    finish: choice.finish_reason ?? '',
    usage: {
      prompt,
      completion,
      reasoning: u.completion_tokens_details?.reasoning_tokens ?? 0,
      total: u.total_tokens ?? prompt + completion,
      // OpenRouter bills the exact figure; elsewhere fall back to list pricing.
      cost: u.cost ?? (req.pricing ? prompt * req.pricing.prompt + completion * req.pricing.completion : 0),
    },
  }
}

/** Best-effort /models listing. Failure is non-fatal everywhere it's used. */
export async function fetchModels(baseUrl: string, apiKey: string): Promise<Map<string, ModelInfo>> {
  const out = new Map<string, ModelInfo>()
  try {
    const res = await fetch(`${trimUrl(baseUrl)}/models`, { headers: headers({ baseUrl, apiKey }) })
    if (!res.ok) return out
    const json = await res.json()
    for (const m of json.data ?? []) {
      if (typeof m?.id !== 'string') continue

      const prompt = Number(m.pricing?.prompt)
      const completion = Number(m.pricing?.completion)
      const priced = Number.isFinite(prompt) && Number.isFinite(completion)

      // A model with no `reasoning` block has no reasoning at all; one that has
      // the block but no effort list reasons some other way (a token budget,
      // say), so there is still no effort to choose.
      const efforts = Array.isArray(m.reasoning?.supported_efforts)
        ? m.reasoning.supported_efforts.filter((e: unknown) => typeof e === 'string')
        : m.reasoning
          ? []
          : undefined

      out.set(m.id, {
        pricing: priced ? { prompt, completion } : undefined,
        efforts,
        defaultEffort: typeof m.reasoning?.default_effort === 'string' ? m.reasoning.default_effort : undefined,
      })
    }
  } catch {
    // Offline, CORS-blocked, or an endpoint without /models — callers cope.
  }
  return out
}

export async function listModels(baseUrl: string, apiKey: string): Promise<string[]> {
  return [...(await fetchModels(baseUrl, apiKey)).keys()].sort()
}
