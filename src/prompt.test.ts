import { describe, expect, test } from 'bun:test'
import { capRetryPrompt, movePrompt, previousGamesPrompt, retryPrompt, systemPrompt, type MovePromptArgs } from './prompt'

const args: MovePromptArgs = {
  fen: 'test-fen',
  pgn: '1. e4 e5',
  legal: [
    { san: 'Nf3', lan: 'g1f3' },
    { san: 'Bc4', lan: 'f1c4' },
  ],
  inCheck: false,
  lastMove: 'e5',
  moveNumber: 2,
  color: 'white',
  player: 'Alpha',
  opponent: 'Beta',
  gameNumber: 2,
  totalGames: 4,
  previousGames: [],
  includePreviousGames: true,
  playerLabels: ['Alpha', 'Beta'],
}

describe('movePrompt', () => {
  test('explicitly identifies the game as chess in the fixed instructions', () => {
    expect(systemPrompt('white', false, 8000)).toContain('playing a game of chess as white')
  })

  test('warns up front that reasoning spends the completion budget', () => {
    const text = systemPrompt('white', false, 8000)
    expect(text).toContain('8,000 tokens')
    expect(text).toContain('internal reasoning counts against it')
  })

  test('renders supported variables and preserves unknown ones', () => {
    expect(movePrompt('{{player}} {{legalMoveCount}} {{legalMoves}} {{unknown}}', args)).toBe(
      'Alpha 2 Nf3 Bc4 {{unknown}}',
    )
  })

  test('formats completed games with colors, result, reason, and moves', () => {
    const text = previousGamesPrompt(
      [{ index: 0, white: 1, result: '0-1', reason: 'checkmate', pgn: '1. e4 e5 2. Nf3' }],
      ['Alpha', 'Beta'],
    )
    expect(text).toContain('Game 1: Beta (White) vs Alpha (Black) — 0-1, checkmate')
    expect(text).toContain('Moves: 1. e4 e5 2. Nf3')
  })

  test('does not render history when the setting is off', () => {
    expect(movePrompt('{{previousGames}}', { ...args, includePreviousGames: false })).toBe('(not included)')
  })
})

describe('retry prompts', () => {
  test('names the token cap instead of calling the reply illegal', () => {
    const text = capRetryPrompt(8000, args.legal)
    expect(text).toContain('8,000-token completion limit')
    expect(text).not.toContain('not a legal chess move')
    expect(text).toContain('Nf3 Bc4')
  })

  test('still calls a genuinely illegal move illegal', () => {
    expect(retryPrompt('Qh9', args.legal)).toContain('"Qh9" is not a legal chess move here.')
  })
})
