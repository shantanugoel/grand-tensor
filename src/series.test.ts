import { afterEach, describe, expect, test } from 'bun:test'
import { Series, type LogEntry } from './series'
import { DEFAULT_PROMPT_TEMPLATE, type Settings } from './settings'

type Reply = { text: string; finish: string }

const settings = (over: Partial<Settings> = {}): Settings => ({
  baseUrl: 'https://example.test/v1',
  apiKey: 'k',
  players: [
    { label: 'Alpha', model: 'alpha', effort: 'default', temperature: 0.2 },
    { label: 'Beta', model: 'beta', effort: 'default', temperature: 0.2 },
  ],
  games: 1,
  maxPlies: 200,
  retries: 1,
  speed: 0,
  commentary: true,
  promptTemplate: DEFAULT_PROMPT_TEMPLATE,
  includePreviousGames: false,
  maxTokens: 8000,
  ...over,
})

/** Answers /models with nothing useful and /chat/completions from `replies`,
 *  recording every request body so the retry conversation can be inspected. */
function stubEndpoint(replies: (model: string, call: number) => Reply) {
  const sent: any[] = []
  const calls = new Map<string, number>()
  globalThis.fetch = (async (url: any, init?: any) => {
    if (String(url).endsWith('/models')) return new Response(JSON.stringify({ data: [] }))
    const body = JSON.parse(init.body)
    sent.push(body)
    const n = (calls.get(body.model) ?? 0) + 1
    calls.set(body.model, n)
    const reply = replies(body.model, n)
    return new Response(
      JSON.stringify({
        choices: [{ message: { content: reply.text }, finish_reason: reply.finish }],
        usage: { prompt_tokens: 10, completion_tokens: 20, total_tokens: 30 },
      }),
    )
  }) as typeof fetch
  return sent
}

const run = async (s: Settings) => {
  const logs: LogEntry[] = []
  const series = new Series(s, {
    onMove: () => {},
    onGameStart: () => {},
    onGameEnd: () => {},
    onThinking: () => {},
    onLog: (entry) => logs.push(entry),
    onUpdate: () => {},
  })
  await series.run()
  return { series, logs }
}

const realFetch = globalThis.fetch
afterEach(() => {
  globalThis.fetch = realFetch
})

describe('token-capped replies', () => {
  test('are counted apart from illegal moves and forfeit as a token cap', async () => {
    stubEndpoint((model) =>
      model === 'alpha'
        ? { text: 'Let me consider the Sicilian, where black', finish: 'length' }
        : { text: '{"move": "e5", "say": "hi"}', finish: 'stop' },
    )

    const { series } = await run(settings())

    expect(series.stats[0].capped).toBe(2) // the first attempt plus one retry
    expect(series.stats[0].illegal).toBe(0)
    expect(series.games[0].reason).toBe('Alpha forfeits (token cap)')
    expect(series.games[0].result).toBe('0-1')
  })

  test('are told the real cause, without the truncated text replayed back', async () => {
    const sent = stubEndpoint(() => ({ text: 'thinking out loud and then the budget ran', finish: 'length' }))

    await run(settings())

    const retry = sent[1].messages
    expect(retry.some((m: any) => m.role === 'assistant')).toBe(false)
    expect(retry.at(-1).content).toContain('8,000-token completion limit')
    expect(retry.at(-1).content).not.toContain('not a legal chess move')
  })

  test('still tell the model its budget up front', async () => {
    const sent = stubEndpoint(() => ({ text: '{"move": "e4"}', finish: 'stop' }))

    await run(settings({ maxTokens: 4096 }))

    expect(sent[0].messages[0].content).toContain('4,096 tokens')
  })
})

describe('illegal replies', () => {
  test('keep the illegal wording and stay out of the cap count', async () => {
    const sent = stubEndpoint((model) =>
      model === 'alpha'
        ? { text: '{"move": "Qh5xf7#"}', finish: 'stop' }
        : { text: '{"move": "e5", "say": "hi"}', finish: 'stop' },
    )

    const { series } = await run(settings())

    expect(series.stats[0].illegal).toBe(2)
    expect(series.stats[0].capped).toBe(0)
    expect(series.games[0].reason).toBe('Alpha forfeits (illegal moves)')
    expect(sent[1].messages.some((m: any) => m.role === 'assistant')).toBe(true)
    expect(sent[1].messages.at(-1).content).toContain('is not a legal chess move here.')
  })

  test('one illegal move among truncations still reads as a chess failure', async () => {
    stubEndpoint((model, call) =>
      model === 'alpha' && call === 1
        ? { text: '{"move": "Ke9"}', finish: 'stop' }
        : model === 'alpha'
          ? { text: 'out of budget again', finish: 'length' }
          : { text: '{"move": "e5"}', finish: 'stop' },
    )

    const { series } = await run(settings())

    expect(series.stats[0].illegal).toBe(1)
    expect(series.stats[0].capped).toBe(1)
    expect(series.games[0].reason).toBe('Alpha forfeits (illegal moves)')
  })
})
