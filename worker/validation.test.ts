import { describe, expect, test } from 'bun:test'
import {
  CIRCUITS,
  DEFAULT_CIRCUIT,
  LEADERBOARD_APP_VERSION,
  RANKED_GAMES_MAX,
  RANKED_GAMES_MIN,
  type LeaderboardSubmission,
  type ProtocolConfig,
} from '../src/leaderboard-protocol'
import { expectedPromptHash, validateSubmission } from './validation'

async function config(): Promise<ProtocolConfig> {
  return {
    baseUrl: 'https://openrouter.ai/api/v1',
    games: 4,
    maxPlies: 200,
    retries: 3,
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

  test('rejects non-standard settings', async () => {
    const value = await submission()
    value.config.retries = 5
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

  test('rejects extra fields rather than silently trusting them', async () => {
    const value = (await submission()) as LeaderboardSubmission & { cost: number }
    value.cost = 0
    await expect(validateSubmission(value)).rejects.toThrow('Invalid submission')
  })
})
