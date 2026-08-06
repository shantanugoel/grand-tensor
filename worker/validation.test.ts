import { describe, expect, test } from 'bun:test'
import { Chess } from 'chess.js'
import { adjudicate } from '../src/adjudication'
import {
  CIRCUITS,
  DEFAULT_CIRCUIT,
  LEADERBOARD_APP_VERSION,
  RANKED_GAMES_MAX,
  RANKED_GAMES_MIN,
  RANKED_RETRIES,
  type LeaderboardSubmission,
  type ProtocolConfig,
} from '../src/leaderboard-protocol'
import { expectedPromptHash, validateSubmission } from './validation'

async function config(): Promise<ProtocolConfig> {
  return {
    baseUrl: 'https://openrouter.ai/api/v1',
    games: 4,
    maxPlies: 200,
    retries: RANKED_RETRIES,
    commentary: true,
    includePreviousGames: true,
    maxTokens: DEFAULT_CIRCUIT.maxTokens,
    promptHash: await expectedPromptHash(),
    players: [
      { model: 'vendor/model-a', effort: 'default', temperature: 0.2 },
      { model: 'vendor/model-b', effort: 'high', temperature: 0.2 },
    ],
  }
}

/** A fool's-mate series of the requested length: Black checkmates every game, so
 *  the side seated as A alternates colors and loses each one. */
const games = (length: number) =>
  Array.from({ length }, (_, index) => ({
    index,
    white: (index % 2) as 0 | 1,
    result: '0-1' as const,
    reason: 'checkmate' as const,
    plies: 4,
    pgn: '1. f3 e5 2. g4 Qh4#',
  }))

async function submission(): Promise<LeaderboardSubmission> {
  return {
    schemaVersion: 1,
    appVersion: LEADERBOARD_APP_VERSION,
    protocol: DEFAULT_CIRCUIT.id,
    installationId: '0198a530-7b3c-7d21-8f47-6381c9d9d643',
    ticket: 'ticket',
    turnstileToken: 'token',
    config: await config(),
    games: games(4),
  }
}

/** A 200-ply game that is still legally alive, found by walking legal moves with
 *  a seeded generator until one comes out on the wanted side of the adjudication
 *  margin. Deterministic, and every property the test relies on is asserted
 *  before it is used. */
function moveLimitGame(want: '1-0' | '0-1' | '1/2-1/2') {
  for (let seed = 1; seed < 400; seed++) {
    let state = seed
    const next = (n: number) => ((state = (state * 1103515245 + 12345) & 0x7fffffff), state % n)
    const chess = new Chess()
    for (let ply = 0; ply < 200 && !chess.isGameOver(); ply++) {
      const moves = chess.moves()
      chess.move(moves[next(moves.length)])
    }
    if (chess.history().length !== 200 || chess.isGameOver()) continue
    if (adjudicate(chess).result === want) return chess.pgn().replace(/\[[^\]]*\]\s*/g, '').trim()
  }
  throw new Error(`No 200-ply position found that adjudicates ${want}`)
}

const moveLimit = (index: number, result: '1-0' | '0-1' | '1/2-1/2', pgn: string) => ({
  index,
  white: (index % 2) as 0 | 1,
  result,
  reason: 'move_limit' as const,
  plies: 200,
  pgn,
})

describe('move-limit adjudication', () => {
  test('accepts the material verdict the position actually supports', async () => {
    for (const want of ['1-0', '0-1', '1/2-1/2'] as const) {
      const value = await submission()
      value.games[0] = moveLimit(0, want, moveLimitGame(want))
      expect((await validateSubmission(value)).games[0].reason).toBe('move_limit')
    }
  })

  test('refuses a move-limit result the position does not support', async () => {
    const pgn = moveLimitGame('1-0')
    for (const claimed of ['0-1', '1/2-1/2'] as const) {
      const value = await submission()
      value.games[0] = moveLimit(0, claimed, pgn)
      await expect(validateSubmission(value)).rejects.toThrow('material adjudication')
    }
  })

  test('still refuses a move-limit claim on a game that ended early', async () => {
    const value = await submission()
    value.games[0] = { ...moveLimit(0, '1/2-1/2', '1. f3 e5 2. g4 Qh4#'), plies: 4 }
    await expect(validateSubmission(value)).rejects.toThrow('not a valid move-limit ending')
  })
})

describe('leaderboard submission validation', () => {
  test('replays legal games and derives model scores', async () => {
    const result = await validateSubmission(await submission())
    expect(result.scoreAX2).toBe(4)
    expect(result.scoreBX2).toBe(4)
    expect(result.winsA).toBe(2)
    expect(result.lossesA).toBe(2)
  })

  test('rejects a fabricated result that disagrees with the board', async () => {
    const value = await submission()
    value.games[0].result = '1-0'
    await expect(validateSubmission(value)).rejects.toThrow('wrong checkmate result')
  })

  test('checks which side receives an illegal-move forfeit', async () => {
    const value = await submission()
    value.games[0] = {
      index: 0,
      white: 0,
      result: '1-0',
      reason: 'illegal_forfeit',
      plies: 0,
      pgn: '',
    }
    await expect(validateSubmission(value)).rejects.toThrow('wrong side')
    value.games[0].result = '0-1'
    expect((await validateSubmission(value)).games[0].reason).toBe('illegal_forfeit')
  })

  test('accepts a token-cap forfeit as its own ending, not as an illegal one', async () => {
    const value = await submission()
    value.games[0] = { index: 0, white: 0, result: '0-1', reason: 'cap_forfeit', plies: 0, pgn: '' }
    expect((await validateSubmission(value)).games[0].reason).toBe('cap_forfeit')

    value.games[0].result = '1-0'
    await expect(validateSubmission(value)).rejects.toThrow('token-cap forfeit to the wrong side')
  })

  test('rejects non-standard settings', async () => {
    const value = await submission()
    value.config.retries = RANKED_RETRIES - 1
    await expect(validateSubmission(value)).rejects.toThrow('ranked protocol')
  })

  test('accepts any series length in the ranked range', async () => {
    const value = await submission()
    value.config.games = 6
    value.games = games(6)
    const result = await validateSubmission(value)
    expect(result.games).toHaveLength(6)
    // Black mates in every game and the colors alternate, so a six-game series
    // splits 3-3 — and the half-point total tracks the length, not a fixed 8.
    expect(result.scoreAX2).toBe(6)
    expect(result.scoreBX2).toBe(6)
    expect(result.winsA).toBe(3)
    expect(result.lossesA).toBe(3)
  })

  test('rejects a series length outside the ranked range', async () => {
    for (const length of [RANKED_GAMES_MIN - 1, RANKED_GAMES_MAX + 1]) {
      const value = await submission()
      value.config.games = length
      value.games = games(length)
      await expect(validateSubmission(value)).rejects.toThrow(
        `${RANKED_GAMES_MIN} to ${RANKED_GAMES_MAX} games`,
      )
    }
  })

  test('rejects an odd series length, which would hand slot 0 an extra White', async () => {
    for (const length of [3, 5]) {
      const value = await submission()
      value.config.games = length
      value.games = games(length)
      await expect(validateSubmission(value)).rejects.toThrow('even')
    }
  })

  test('rejects a game list that disagrees with the declared series length', async () => {
    const value = await submission()
    value.config.games = 6
    await expect(validateSubmission(value)).rejects.toThrow('declared 6 games')
  })

  test('routes a submission to the circuit its completion cap belongs to', async () => {
    const extended = CIRCUITS.find((circuit) => circuit.id !== DEFAULT_CIRCUIT.id)!
    const value = await submission()
    value.config.maxTokens = extended.maxTokens
    value.protocol = extended.id
    expect((await validateSubmission(value)).circuit.id).toBe(extended.id)
  })

  test('rejects a cap that belongs to no circuit', async () => {
    const value = await submission()
    value.config.maxTokens = 8000
    await expect(validateSubmission(value)).rejects.toThrow('ranked completion budget')
  })

  test('refuses a submission that claims a circuit its settings contradict', async () => {
    const extended = CIRCUITS.find((circuit) => circuit.id !== DEFAULT_CIRCUIT.id)!
    const value = await submission()
    value.protocol = extended.id
    await expect(validateSubmission(value)).rejects.toThrow('does not match its settings')
  })

  test('lets one model face itself at a different effort', async () => {
    const value = await submission()
    value.config.players[1] = { ...value.config.players[0], effort: 'low' }
    const result = await validateSubmission(value)
    expect(result.config.players[0].effort).toBe('default')
    expect(result.config.players[1].effort).toBe('low')
  })

  test('still refuses an exact self-pairing', async () => {
    const value = await submission()
    value.config.players[1] = { ...value.config.players[0] }
    await expect(validateSubmission(value)).rejects.toThrow('cannot play itself')
  })

  test('accepts a client newer than the Worker, and rejects an older one', async () => {
    const bump = (index: number, by: number) => {
      const parts = LEADERBOARD_APP_VERSION.split('.').map(Number)
      parts[index] += by
      return parts.join('.')
    }

    for (const newer of [bump(0, 1), bump(1, 1), bump(2, 1)]) {
      const value = await submission()
      value.appVersion = newer
      expect((await validateSubmission(value)).appVersion).toBe(newer)
    }

    // Well-formed but genuinely behind, then malformed — both are refused, and
    // bump(1, -1) keeps this honest if the current version ever gains a minor.
    for (const older of [bump(1, -1), '0.0.1', 'not-a-version', '1.0']) {
      const value = await submission()
      value.appVersion = older
      await expect(validateSubmission(value)).rejects.toThrow('refresh')
    }
  })

  test('rejects extra fields rather than silently trusting them', async () => {
    const value = (await submission()) as LeaderboardSubmission & { cost: number }
    value.cost = 0
    await expect(validateSubmission(value)).rejects.toThrow('Invalid submission')
  })
})
