/** Wire shape of a completion request, and what comes back off the usage block.
 *
 *  Focused on the caching path: which providers are told where the reusable
 *  prefix ends, and which are quietly sent the same prompt as a plain string. */

import { afterEach, describe, expect, test } from 'bun:test'
import { addUsage, chat, emptyUsage, type ChatContent } from './llm'

const realFetch = globalThis.fetch
afterEach(() => {
  globalThis.fetch = realFetch
})

type Captured = { body: any }

/** Stubs the endpoint and hands back whatever body the client sent. */
function capture(usage: Record<string, unknown> = {}): Captured {
  const seen: Captured = { body: null }
  globalThis.fetch = (async (_url: string, init: RequestInit) => {
    seen.body = JSON.parse(String(init.body))
    return new Response(
      JSON.stringify({ choices: [{ message: { content: '{"move":"e4"}' }, finish_reason: 'stop' }], usage }),
      { status: 200 },
    )
  }) as typeof fetch

  return seen
}

const send = (baseUrl: string, model: string, content: ChatContent) =>
  chat({ baseUrl, apiKey: 'k', model, temperature: 0, maxTokens: 100, effort: 'default', messages: [{ role: 'user', content }] })

const SPLIT: ChatContent = [{ text: 'stable half', cacheBreakpoint: true }, { text: 'volatile half' }]

describe('cache breakpoint on the wire', () => {
  test('marks the prefix for a model that only caches when told', async () => {
    const seen = capture()
    await send('https://openrouter.ai/api/v1', 'anthropic/claude-sonnet-5', SPLIT)
    expect(seen.body.messages[0].content).toEqual([
      { type: 'text', text: 'stable half', cache_control: { type: 'ephemeral' } },
      { type: 'text', text: 'volatile half' },
    ])
  })

  test('sends a plain string to a model that caches on its own', async () => {
    // The reordering is what earns the hit here; a marker would be noise at best
    // and a rejected field at worst.
    const seen = capture()
    await send('https://openrouter.ai/api/v1', 'openai/gpt-5.6-luna', SPLIT)
    expect(seen.body.messages[0].content).toBe('stable halfvolatile half')
  })

  test('sends a plain string to a non-OpenRouter endpoint', async () => {
    // `cache_control` is an extension a bare OpenAI-compatible server never agreed
    // to accept, and a 400 is a worse outcome than an uncached prompt.
    const seen = capture()
    await send('https://example.test/v1', 'anthropic/claude-sonnet-5', SPLIT)
    expect(seen.body.messages[0].content).toBe('stable halfvolatile half')
  })

  test('rejoins to exactly the string form of the same prompt', async () => {
    const split = capture()
    await send('https://example.test/v1', 'some/model', SPLIT)
    const whole = capture()
    await send('https://example.test/v1', 'some/model', 'stable halfvolatile half')
    expect(split.body.messages[0].content).toBe(whole.body.messages[0].content)
  })

  test('passes an unsplit string through untouched', async () => {
    const seen = capture()
    await send('https://openrouter.ai/api/v1', 'anthropic/claude-sonnet-5', 'one piece')
    expect(seen.body.messages[0].content).toBe('one piece')
  })
})

describe('cache usage reporting', () => {
  test('reads the cache counters OpenRouter reports', async () => {
    capture({ prompt_tokens: 6879, completion_tokens: 5, cost: 0.0039, prompt_tokens_details: { cached_tokens: 5546, cache_write_tokens: 0 } })
    const res = await send('https://openrouter.ai/api/v1', 'anthropic/claude-sonnet-5', SPLIT)
    expect(res.usage.cacheRead).toBe(5546)
    expect(res.usage.cacheWrite).toBe(0)
  })

  test('treats a provider that reports nothing as having cached nothing', async () => {
    capture({ prompt_tokens: 100, completion_tokens: 5 })
    const res = await send('https://example.test/v1', 'some/model', 'x')
    expect(res.usage.cacheRead).toBe(0)
    expect(res.usage.cacheWrite).toBe(0)
  })

  test('accumulates cache counters across the calls in a turn', () => {
    const write = { ...emptyUsage(), cacheWrite: 1245 }
    const read = { ...emptyUsage(), cacheRead: 1245 }
    const total = addUsage(write, read)
    expect(total.cacheWrite).toBe(1245)
    expect(total.cacheRead).toBe(1245)
  })
})
