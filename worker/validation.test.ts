import { describe, expect, test } from 'bun:test'
import {
  LEADERBOARD_APP_VERSION,
  LEADERBOARD_PROTOCOL,
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
    maxTokens: 8000,
    promptHash: await expectedPromptHash(),
    players: [
      { model: 'vendor/model-a', effort: 'default', temperature: 0.2 },
      { model: 'vendor/model-b', effort: 'high', temperature: 0.2 },
    ],
  }
}

async function submission(): Promise<LeaderboardSubmission> {
  return {
    schemaVersion: 1,
    appVersion: LEADERBOARD_APP_VERSION,
    protocol: LEADERBOARD_PROTOCOL,
    installationId: '0198a530-7b3c-7d21-8f47-6381c9d9d643',
    ticket: 'ticket',
    turnstileToken: 'token',
    config: await config(),
    games: Array.from({ length: 4 }, (_, index) => ({
      index,
      white: (index % 2) as 0 | 1,
      result: '0-1' as const,
      reason: 'checkmate' as const,
      plies: 4,
      pgn: '1. f3 e5 2. g4 Qh4#',
    })),
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
    value.config.games = 6
    await expect(validateSubmission(value)).rejects.toThrow('Standard Circuit')
  })

  test('rejects extra fields rather than silently trusting them', async () => {
    const value = (await submission()) as LeaderboardSubmission & { cost: number }
    value.cost = 0
    await expect(validateSubmission(value)).rejects.toThrow('Invalid submission')
  })
})
