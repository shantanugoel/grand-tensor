/** Minimal OpenAI-compatible chat client. Works with OpenRouter, OpenAI, or any
 *  server exposing /chat/completions. No SDK — one fetch, one parse. */

import type { Effort } from './settings'

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

export type ChatRequest = {
  baseUrl: string
  apiKey: string
  model: string
  effort: Effort
  temperature: number
  maxTokens: number
  messages: { role: 'system' | 'user' | 'assistant'; content: string }[]
  /** Used to derive a cost when the response doesn't report one itself. */
  pricing?: Pricing
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

  if (req.effort !== 'default') {
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
export async function fetchModels(baseUrl: string, apiKey: string): Promise<Map<string, Pricing | undefined>> {
  const out = new Map<string, Pricing | undefined>()
  try {
    const res = await fetch(`${trimUrl(baseUrl)}/models`, { headers: headers({ baseUrl, apiKey }) })
    if (!res.ok) return out
    const json = await res.json()
    for (const m of json.data ?? []) {
      if (typeof m?.id !== 'string') continue
      const prompt = Number(m.pricing?.prompt)
      const completion = Number(m.pricing?.completion)
      const priced = Number.isFinite(prompt) && Number.isFinite(completion)
      out.set(m.id, priced ? { prompt, completion } : undefined)
    }
  } catch {
    // Offline, CORS-blocked, or an endpoint without /models — callers cope.
  }
  return out
}

export async function listModels(baseUrl: string, apiKey: string): Promise<string[]> {
  return [...(await fetchModels(baseUrl, apiKey)).keys()].sort()
}
