import { describe, expect, test } from 'bun:test'
import { Chess } from 'chess.js'
import { DEFAULT_PROMPT_TEMPLATE } from './settings'
import {
  capRetryPrompt,
  movePrompt,
  parseMove,
  previousGamesPrompt,
  retryPrompt,
  systemPrompt,
  type MovePromptArgs,
} from './prompt'

const args: MovePromptArgs = {
  fen: 'test-fen',
  board: 'test-board',
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

  test('draws the board out as well as naming the FEN', () => {
    const board = new Chess().ascii()
    expect(movePrompt(DEFAULT_PROMPT_TEMPLATE, { ...args, board })).toContain(board)
  })

  test('drops the PGN result token rather than calling it a move', () => {
    // chess.js terminates movetext with a result — `*` while unfinished — which
    // rendered a fresh game as "Moves so far: *".
    expect(movePrompt('{{moves}}', { ...args, pgn: new Chess().pgn() })).toBe('(none)')
    expect(movePrompt('{{moves}}', { ...args, pgn: '1. e4 e5 *' })).toBe('1. e4 e5')
    expect(movePrompt('{{moves}}', { ...args, pgn: '1. f3 e5 2. g4 Qh4# 0-1' })).toBe('1. f3 e5 2. g4 Qh4#')
  })

  test('does not repeat a finished result inside that game’s move list', () => {
    const text = previousGamesPrompt(
      [{ index: 0, white: 0, result: '1-0', reason: 'checkmate', pgn: '[Event "?"]\n\n1. e4 e5 1-0' }],
      ['Alpha', 'Beta'],
    )
    expect(text).toContain('Moves: 1. e4 e5')
    expect(text).not.toContain('e5 1-0')
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

  test('calls malformed notation invalid while still demanding a legal-list move', () => {
    const text = retryPrompt('gh6', [{ san: 'gxh6', lan: 'g7h6' }], 'invalid_notation', 'gxh6')
    expect(text).toContain('"gh6" is invalid move notation here.')
    expect(text).toContain('Did you mean "gxh6"?')
    expect(text).toContain('gxh6')
  })

  test('identifies a response with no nominated move', () => {
    expect(retryPrompt('', args.legal, 'invalid_response')).toContain(
      'did not contain a usable "move" value',
    )
  })
})

describe('parseMove', () => {
  const legal = args.legal

  test('reads the move and the commentary out of the requested JSON', () => {
    expect(parseMove('{"move": "Nf3", "say": "Knights first."}', legal)).toMatchObject({
      san: 'Nf3',
      say: 'Knights first.',
    })
  })

  test('tolerates code fences, decorations and long algebraic notation', () => {
    expect(parseMove('```json\n{"move": "Nf3+!"}\n```', legal).san).toBe('Nf3')
    expect(parseMove('{"move": "g1f3"}', legal).san).toBe('Nf3')
  })

  test('stops at the first balanced object rather than the last brace anywhere', () => {
    // The greedy match this replaced ran to the final `}` and failed to parse.
    expect(parseMove('{"move": "Bc4"} — and then White is better }', legal).san).toBe('Bc4')
  })

  test('repairs an object that is malformed somewhere other than the move', () => {
    expect(parseMove('{"move": "Nf3", "say": "he said "hi" to me"}', legal).san).toBe('Nf3')
  })

  test('refuses to mine a move out of prose', () => {
    // The whole point: this reply argues *against* Nf3 and never answers. Playing
    // it would credit the model with a move it explicitly rejected.
    const reasoning = 'I could try Bc4 here, but after that Black equalises, so not Nf3'
    expect(parseMove(reasoning, legal).san).toBeNull()
  })

  test('reports no move for an empty or move-less reply', () => {
    expect(parseMove('', legal)).toMatchObject({ san: null, rejection: 'invalid_response' })
    expect(parseMove('{"say": "thinking..."}', legal)).toMatchObject({
      san: null,
      rejection: 'invalid_response',
    })
  })

  test('still reports an illegal move the model actually nominated', () => {
    const parsed = parseMove('{"move": "Qh5"}', legal)
    expect(parsed.san).toBeNull()
    expect(parsed.raw).toBe('Qh5')
    expect(parsed.rejection).toBe('illegal_move')
  })

  test('distinguishes malformed notation without accepting it', () => {
    const parsed = parseMove('{"move": "gh6"}', [{ san: 'gxh6', lan: 'g7h6' }])
    expect(parsed.san).toBeNull()
    expect(parsed.raw).toBe('gh6')
    expect(parsed.rejection).toBe('invalid_notation')
    expect(parsed.suggestion).toBe('gxh6')
    expect(parseMove('{"move": "Qh9"}', legal).rejection).toBe('invalid_notation')
    expect(parseMove('{"move": "Qh5xf7"}', legal).rejection).toBe('invalid_notation')
  })
})
