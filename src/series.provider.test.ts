/** Series behaviour against a mock OpenAI-compatible provider.
 *
 *  Covers the reply shapes real providers actually produce — reasoning in a
 *  separate field, empty content, prose without JSON, malformed JSON — and what
 *  each one is now scored as. Complements series.test.ts, which covers the
 *  connection-failure and retry-budget machinery. */

import { afterEach, describe, expect, test } from 'bun:test'
import { Chess } from 'chess.js'
import { Series, type LogEntry } from './series'
import { DEFAULT_PROMPT_TEMPLATE, type Settings } from './settings'

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
  networkRetries: 0,
  speed: 0,
  commentary: true,
  promptTemplate: DEFAULT_PROMPT_TEMPLATE,
  includePreviousGames: true,
  maxTokens: 16000,
  ...over,
})

class InstantSeries extends Series {
  protected sleep(): Promise<void> {
    return Promise.resolve()
  }
}

type Reply = { content?: string | null; reasoning?: string; finish?: string }

/** A provider that answers each move by consulting `reply`, and plays a real
 *  legal move whenever that returns nothing — so a game can actually progress
 *  while one specific reply shape is under test. */
function provider(reply: (model: string, call: number) => Reply | null, models: any[] = []) {
  const sent: any[] = []
  const calls = new Map<string, number>()
  const board = new Chess()

  globalThis.fetch = (async (url: any, init?: any) => {
    if (String(url).endsWith('/models')) return Response.json({ data: models })
    const body = JSON.parse(init.body)
    sent.push(body)
    const n = (calls.get(body.model) ?? 0) + 1
    calls.set(body.model, n)

    // Track the position from the FEN the prompt carries, so the fallback move
    // is genuinely legal in the position being asked about.
    const fen = body.messages.at(-1).content.match(/FEN: (\S+ \S+ \S+ \S+ \S+ \S+)/)?.[1]
    let legal = 'e4'
    if (fen) {
      board.load(fen)
      legal = board.moves()[0]
    }

    const custom = reply(body.model, n)
    const answer: Reply = custom ?? { content: JSON.stringify({ move: legal, say: 'ok' }), finish: 'stop' }
    return Response.json({
      choices: [
        {
          message: { content: answer.content ?? null, reasoning: answer.reasoning },
          finish_reason: answer.finish ?? 'stop',
        },
      ],
      usage: { prompt_tokens: 10, completion_tokens: 20, total_tokens: 30 },
    })
  }) as typeof fetch

  return sent
}

function build(s: Settings) {
  const logs: LogEntry[] = []
  const series: Series = new InstantSeries(s, {
    onMove: () => {},
    onGameStart: () => {},
    onGameEnd: () => {},
    onThinking: () => {},
    onLog: (entry) => logs.push(entry),
    onUpdate: () => {},
  })
  return { series, logs }
}

const run = async (s: Settings) => {
  const built = build(s)
  await built.series.run()
  return built
}

const realFetch = globalThis.fetch
afterEach(() => {
  globalThis.fetch = realFetch
})

describe('reply shapes a provider actually returns', () => {
  test('a reasoning trace with empty content is a non-answer, not a move', async () => {
    // The trace mentions legal moves and ends on one it is rejecting. Mining it
    // would have credited Alpha with that move.
    provider((model) =>
      model === 'alpha'
        ? { content: '', reasoning: 'I could open e4, or d4. Not Nf3 though, that just transposes to Nf3', finish: 'stop' }
        : null,
    )

    const { series } = await run(settings({ retries: 1 }))

    expect(series.stats[0].moves).toBe(0)
    expect(series.stats[0].capped).toBe(2)
    expect(series.stats[0].illegal).toBe(0)
    expect(series.games[0].reason).toBe('Alpha forfeits (token cap)')
  })

  test('prose naming a legal move but carrying no JSON scores nothing', async () => {
    provider((model) => (model === 'alpha' ? { content: 'I will play e4.', finish: 'stop' } : null))

    const { series } = await run(settings({ retries: 1 }))

    expect(series.stats[0].moves).toBe(0)
    // A real answer that missed the shape: an illegal reply, not a budget one.
    expect(series.stats[0].illegal).toBe(2)
    expect(series.stats[0].capped).toBe(0)
    expect(series.games[0].reason).toBe('Alpha forfeits (illegal moves)')
  })

  test('empty content with finish "stop" counts as capped, not illegal', async () => {
    provider((model, call) =>
      model === 'alpha' && call === 1 ? { content: '', finish: 'stop' } : null,
    )

    const { series, logs } = await run(settings({ retries: 2, maxPlies: 4 }))

    expect(series.stats[0].capped).toBe(1)
    expect(series.stats[0].illegal).toBe(0)
    expect(logs.some((l) => l.text.includes('Reply ended without a move'))).toBe(true)
    // It recovered on the retry, so the game went on.
    expect(series.stats[0].moves).toBeGreaterThan(0)
  })

  test('accepts JSON wrapped in fences, with trailing prose, or malformed elsewhere', async () => {
    for (const content of [
      '```json\n{"move": "e4", "say": "hi"}\n```',
      '{"move": "e4"} — solid opening }',
      '{"move": "e4", "say": "he said "go" to me"}',
    ]) {
      provider((model, call) => (model === 'alpha' && call === 1 ? { content, finish: 'stop' } : null))
      const { series } = await run(settings({ maxPlies: 2 }))
      expect(`${content.slice(0, 12)}: ${series.stats[0].illegal}`).toBe(`${content.slice(0, 12)}: 0`)
      expect(series.games[0].pgn).toContain('e4')
    }
  })
})

describe('what the provider is sent', () => {
  test('carries the drawn board and no stray PGN result token', async () => {
    const sent = provider(() => null)
    await run(settings({ maxPlies: 2 }))

    const first = sent[0].messages.at(-1).content
    expect(first).toContain('+------------------------+')
    expect(first).toContain('8 | r  n  b  q  k  b  n  r |')
    expect(first).toContain('Moves so far: (none)')
    expect(first).not.toContain('Moves so far: *')

    // The reply to move two must show the actual movetext, still unterminated.
    const second = sent[1].messages.at(-1).content
    expect(second).toMatch(/Moves so far: 1\. \w+/)
    expect(second).not.toMatch(/Moves so far:.*\*/)
  })

  test('sends the ranked knobs the protocol pins', async () => {
    const sent = provider(() => null)
    await run(settings({ maxPlies: 2, maxTokens: 16000 }))

    expect(sent[0].max_tokens).toBe(16000)
    expect(sent[0].temperature).toBe(0.2)
    expect(sent[0].messages[0].role).toBe('system')
    expect(sent[0].messages[0].content).toContain('16,000 tokens')
    // "default" effort means the parameter is not sent at all.
    expect(sent[0].reasoning).toBeUndefined()
    expect(sent[0].reasoning_effort).toBeUndefined()
  })

  test('accepts optional reasoning as off and sends the disable request', async () => {
    const models = [
      {
        id: 'alpha',
        reasoning: { supported_efforts: ['max', 'high', 'low'], mandatory: false },
      },
      {
        id: 'beta',
        reasoning: { supported_efforts: ['max', 'xhigh', 'high', 'medium', 'low', 'none'], mandatory: false },
      },
    ]
    const sent = provider(() => null, models)
    const configured = settings({
      baseUrl: 'https://openrouter.ai/api/v1',
      maxPlies: 2,
      players: [
        { label: 'Alpha', model: 'alpha', effort: 'off', temperature: 0.2 },
        // Old links and settings may still carry OpenRouter's spelling.
        { label: 'Beta', model: 'beta', effort: 'none', temperature: 0.2 },
      ],
    })

    const { series, logs } = await run(configured)

    expect(series.resolvedEffort).toEqual(['off', 'off'])
    expect(logs.some((entry) => entry.kind === 'warn')).toBe(false)
    expect(sent[0].reasoning).toEqual({ enabled: false })
    expect(sent[1].reasoning).toEqual({ enabled: false })
  })

  test('replays finished games into later prompts without their result token', async () => {
    const sent = provider(() => null)
    await run(settings({ games: 2, maxPlies: 2 }))

    const secondGame = sent.find((body) => body.messages.at(-1).content.includes('This is game 2 of 2'))
    expect(secondGame).toBeDefined()
    const text = secondGame.messages.at(-1).content
    expect(text).toContain('Game 1: Alpha (White) vs Beta (Black)')
    expect(text).toMatch(/Moves: 1\. \w+/)
    expect(text).not.toMatch(/Moves:.*(\*|1\/2-1\/2)$/m)
  })
})

describe('series outcomes', () => {
  test('adjudicates the ply limit on material and scores it as a win', async () => {
    // Beta hands back material by answering with whatever is legal; Alpha is
    // steered to capture. The assertion is on the adjudication, not the chess.
    provider(() => null)
    const { series } = await run(settings({ maxPlies: 30 }))

    const record = series.games[0]
    expect(record.reason).toContain('move limit (30 plies)')
    // Either a draw or an adjudicated decision, but never scored as both.
    if (record.result === '1/2-1/2') expect(record.reason).not.toContain('adjudicated')
    else {
      expect(record.reason).toMatch(/adjudicated to (White|Black), \+\d+ material/)
      expect(series.stats[0].score + series.stats[1].score).toBe(1)
    }
  })

  test('alternates colors and totals the score across a series', async () => {
    provider(() => null)
    const { series } = await run(settings({ games: 4, maxPlies: 2 }))

    expect(series.games.map((g) => g.white)).toEqual([0, 1, 0, 1])
    expect(series.games).toHaveLength(4)
    expect(series.stats[0].score + series.stats[1].score).toBe(4)
    expect(series.status).toBe('done')
  })

  test('spends the full retry budget before forfeiting', async () => {
    provider((model) => (model === 'alpha' ? { content: '{"move": "Qh9"}', finish: 'stop' } : null))
    const { series } = await run(settings({ retries: 5 }))

    // Six attempts: the first plus five retries.
    expect(series.stats[0].illegal).toBe(6)
    expect(series.stats[0].calls).toBe(6)
    expect(series.games[0].reason).toBe('Alpha forfeits (illegal moves)')
    expect(series.games[0].result).toBe('0-1')
  })
})
