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
  networkRetries: 2,
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

/** Backoff waits are the point of the retry loop but nothing to sit through in
 *  a test, so the only thing overridden is the clock. */
class InstantSeries extends Series {
  protected sleep(): Promise<void> {
    return Promise.resolve()
  }
}

function build(s: Settings, onUpdate: (series: Series) => void = () => {}) {
  const logs: LogEntry[] = []
  const series: Series = new InstantSeries(s, {
    onMove: () => {},
    onGameStart: () => {},
    onGameEnd: () => {},
    onThinking: () => {},
    onLog: (entry) => logs.push(entry),
    onUpdate: () => onUpdate(series),
  })
  return { series, logs }
}

const run = async (s: Settings) => {
  const { series, logs } = build(s)
  await series.run()
  return { series, logs }
}

const realFetch = globalThis.fetch
afterEach(() => {
  globalThis.fetch = realFetch
})

/** Full control over each chat call: return a Response to answer it, or an Error
 *  to fail it the way the network does. */
function stubCalls(handler: (call: number) => Response | Error) {
  let calls = 0
  globalThis.fetch = (async (url: any) => {
    if (String(url).endsWith('/models')) return new Response(JSON.stringify({ data: [] }))
    const out = handler(++calls)
    if (out instanceof Error) throw out
    return out
  }) as typeof fetch
  return () => calls
}

const answer = (move: string) =>
  new Response(
    JSON.stringify({
      choices: [{ message: { content: `{"move": "${move}"}` }, finish_reason: 'stop' }],
      usage: { prompt_tokens: 10, completion_tokens: 20, total_tokens: 30 },
    }),
  )

/** A two-ply game: 1. e4 e5, then the ply limit adjudicates a draw. */
function openingMoves() {
  const moves = ['e4', 'e5']
  let played = 0
  return () => answer(moves[played++] ?? 'e4')
}

describe('connection failures', () => {
  test('are ridden out without spending the move budget', async () => {
    const opening = openingMoves()
    const calls = stubCalls((call) => (call <= 2 ? new TypeError('Failed to fetch') : opening()))

    const { series, logs } = await run(settings({ maxPlies: 2, networkRetries: 3 }))

    expect(series.status).toBe('done')
    expect(calls()).toBe(4) // two dropped, then the two real moves
    // A dropped connection is not a chess mistake, so nothing lands on the record.
    expect(series.stats[0].illegal).toBe(0)
    expect(series.stats[0].capped).toBe(0)
    expect(series.stats[0].calls).toBe(1)
    expect(logs.some((l) => l.kind === 'warn' && l.text.startsWith('Connection failed'))).toBe(true)
  })

  test('stall the series once the cap runs out, and retry resumes the same move', async () => {
    const opening = openingMoves()
    let offline = true
    const calls = stubCalls(() => (offline ? new TypeError('Failed to fetch') : opening()))

    // Stand in for someone hitting Retry once the network is back.
    const { series, logs } = build(settings({ maxPlies: 2, networkRetries: 1 }), (s) => {
      if (s.status !== 'stalled') return
      offline = false
      s.retry()
    })
    await series.run()

    expect(series.status).toBe('done')
    expect(calls()).toBe(4) // the first attempt, its one retry, then both moves
    expect(logs.some((l) => l.kind === 'error' && l.text.startsWith('Series stalled'))).toBe(true)
    // The stall cost the position nothing: white still played the move it was on.
    expect(series.games[0].pgn).toContain('e4')
    expect(series.stats[0].moves).toBe(1)
  })

  test('a rejected key stalls at once instead of burning the retry budget', async () => {
    const calls = stubCalls(() => new Response(JSON.stringify({ error: { message: 'invalid key' } }), { status: 401 }))

    const { series, logs } = build(settings({ maxPlies: 2, networkRetries: 5 }), (s) => {
      if (s.status === 'stalled') s.stop()
    })
    await series.run()

    expect(calls()).toBe(1)
    expect(series.status).toBe('idle')
    const stall = logs.find((l) => l.kind === 'error')
    expect(stall?.text).toContain('401')
    expect(stall?.detail).toContain('check the API key')
  })
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
  test('labels a move-less nonempty reply invalid but charges the illegal budget', async () => {
    const sent = stubEndpoint(() => ({
      text: '{"say": "I forgot to nominate a move."}',
      finish: 'stop',
    }))

    const { series, logs } = await run(settings())

    expect(series.stats[0].illegal).toBe(2)
    expect(series.stats[0].capped).toBe(0)
    expect(series.games[0].reason).toBe('Alpha forfeits (illegal moves)')
    expect(logs.some((l) => l.text.startsWith('Invalid response — attempt 1 of 2'))).toBe(true)
    expect(sent[1].messages.at(-1).content).toContain(
      'did not contain a usable "move" value',
    )
  })

  test('labels missing capture notation separately but charges the illegal budget', async () => {
    const sent = stubEndpoint((model, call) => {
      if (model === 'alpha' && call === 1) return { text: '{"move": "e4"}', finish: 'stop' }
      if (model === 'beta') return { text: '{"move": "d5"}', finish: 'stop' }
      return { text: '{"move": "ed5"}', finish: 'stop' }
    })

    const { series, logs } = await run(settings())

    expect(series.stats[0].illegal).toBe(2)
    expect(series.stats[0].capped).toBe(0)
    expect(series.games[0].reason).toBe('Alpha forfeits (illegal moves)')
    expect(logs.some((l) => l.text.startsWith('Invalid move notation "ed5"'))).toBe(true)
    expect(logs.some((l) => l.detail === 'Did you mean "exd5"?')).toBe(true)
    expect(sent[3].messages.at(-1).content).toContain('"ed5" is invalid move notation here.')
    expect(sent[3].messages.at(-1).content).toContain('Did you mean "exd5"?')
  })

  test('keep the illegal wording and stay out of the cap count', async () => {
    const sent = stubEndpoint((model) =>
      model === 'alpha'
        ? { text: '{"move": "Qh5"}', finish: 'stop' }
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
