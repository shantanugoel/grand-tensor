import { describe, expect, test } from 'bun:test'
import { Chess } from 'chess.js'
import {
  BLITZ_ANIM,
  buildStoryboard,
  cardMsFor,
  estimateMs,
  paceFor,
  parseMoves,
  POST_LIMIT_MS,
  runningScores,
  TARGET_MS,
  winnerOf,
} from './replay'
import type { GameRecord } from './series'

/** Scholar's mate, as chess.js would have stored it. */
function scholars(): string {
  const chess = new Chess()
  for (const san of ['e4', 'e5', 'Bc4', 'Nc6', 'Qh5', 'Nf6', 'Qxf7#']) chess.move(san)
  return chess.pgn()
}

const game = (over: Partial<GameRecord> = {}): GameRecord => ({
  index: 0,
  white: 0,
  result: '1-0',
  reason: 'checkmate',
  plies: 7,
  pgn: scholars(),
  ...over,
})

describe('parseMoves', () => {
  test('recovers the moves a stored PGN was built from', () => {
    expect(parseMoves(scholars())).toEqual(['e4', 'e5', 'Bc4', 'Nc6', 'Qh5', 'Nf6', 'Qxf7#'])
  })

  test('replays back onto a board without a rejected move', () => {
    const board = new Chess()
    for (const san of parseMoves(scholars())) expect(board.move(san)).toBeTruthy()
    expect(board.isCheckmate()).toBe(true)
  })

  test('gives up on an unreadable PGN instead of throwing', () => {
    expect(parseMoves('1. e4 e5 2. Qxh8 zzz')).toEqual([])
    expect(parseMoves('')).toEqual([])
  })
})

describe('winnerOf', () => {
  test('reads the result through whoever had white', () => {
    expect(winnerOf(game({ result: '1-0', white: 0 }))).toBe(0)
    expect(winnerOf(game({ result: '1-0', white: 1 }))).toBe(1)
    expect(winnerOf(game({ result: '0-1', white: 0 }))).toBe(1)
    expect(winnerOf(game({ result: '0-1', white: 1 }))).toBe(0)
    expect(winnerOf(game({ result: '1/2-1/2' }))).toBeNull()
  })
})

describe('runningScores', () => {
  test('opens at nil-nil and splits a draw', () => {
    const scores = runningScores([
      game({ index: 0, white: 0, result: '1-0' }),
      game({ index: 1, white: 1, result: '1/2-1/2' }),
      game({ index: 2, white: 0, result: '0-1' }),
    ])
    expect(scores).toEqual([
      [0, 0],
      [1, 0],
      [1.5, 0.5],
      [1.5, 1.5],
    ])
  })
})

describe('paceFor', () => {
  test('replays a normal series at Blitz', () => {
    // Four games of 60 plies each: nowhere near the budget.
    expect(paceFor(240, cardMsFor(4))).toBe(BLITZ_ANIM)
  })

  test('never runs slower than Blitz, however short the series', () => {
    expect(paceFor(1, cardMsFor(1))).toBe(BLITZ_ANIM)
    expect(paceFor(0, cardMsFor(0))).toBe(BLITZ_ANIM)
  })

  test('tightens a series that would overrun the budget', () => {
    const plies = 800
    const cards = cardMsFor(4)
    const anim = paceFor(plies, cards)
    expect(anim).toBeLessThan(BLITZ_ANIM)
    expect(estimateMs(plies, cards, anim)).toBeLessThanOrEqual(TARGET_MS)
  })

  test('keeps every realistic series inside the target', () => {
    for (const [games, plies] of [
      [1, 200],
      [4, 200],
      [4, 800],
      [6, 1000],
    ]) {
      const cards = cardMsFor(games)
      expect(estimateMs(plies, cards, paceFor(plies, cards))).toBeLessThanOrEqual(TARGET_MS)
    }
  })

  test('stays watchable rather than fitting an absurd series', () => {
    // Fifty adjudicated games is the worst case the settings allow. Each ply
    // costs a frame or two that no animation scale removes, so this bottoms out
    // on the floor and overruns — main.ts says so before recording.
    const anim = paceFor(10_000, cardMsFor(50))
    expect(anim).toBeGreaterThan(0)
    expect(anim).toBeLessThan(BLITZ_ANIM)
    expect(estimateMs(10_000, cardMsFor(50), anim)).toBeGreaterThan(POST_LIMIT_MS)
  })
})

describe('estimateMs', () => {
  test('grows with plies and with the animation scale', () => {
    expect(estimateMs(100, 0, 0.35)).toBeGreaterThan(estimateMs(50, 0, 0.35))
    expect(estimateMs(100, 0, 0.35)).toBeGreaterThan(estimateMs(100, 0, 0.2))
    expect(estimateMs(0, 5000, 0.35)).toBe(5000)
  })
})

describe('buildStoryboard', () => {
  const names: [string, string] = ['Alpha', 'Beta']
  const built = () =>
    buildStoryboard({
      games: [
        game({ index: 0, white: 0, result: '1-0', reason: 'checkmate', plies: 7 }),
        game({ index: 1, white: 1, result: '1/2-1/2', reason: 'stalemate', plies: 7 }),
      ],
      names,
      totalGames: 4,
      url: 'https://example.test/#a=x',
    })

  test('carries every game’s moves', () => {
    const story = built()
    expect(story.games).toHaveLength(2)
    expect(story.games[0].moves).toHaveLength(7)
    expect(story.totalPlies).toBe(14)
  })

  test('names the right side in each game’s title card', () => {
    const story = built()
    const text = (i: number) => story.games[i].intro.lines.map((l) => l.text)
    expect(text(0)).toContain('GAME 1 OF 4')
    // Alpha has white in game 1, Beta in game 2 — the white line comes first.
    expect(text(0)[1]).toBe('ALPHA')
    expect(text(1)[1]).toBe('BETA')
  })

  test('holds the score back rather than spoiling the ending', () => {
    const story = built()
    expect(story.games[0].scoreBefore).toEqual(['0', '0'])
    expect(story.games[0].scoreAfter).toEqual(['1', '0'])
    expect(story.games[1].scoreBefore).toEqual(['1', '0'])
    // fmtScore spells a lone half point "0½", the same as the HUD does.
    expect(story.games[1].scoreAfter).toEqual(['1½', '0½'])
  })

  test('closes on the final score and the crown', () => {
    const lines = built().outro.lines.map((l) => l.text)
    expect(lines[0]).toBe('1½ – 0½')
    expect(lines[1]).toBe('ALPHA TAKES THE CROWN')
    expect(lines[2]).toBe('https://example.test/#a=x')
  })

  test('calls a level series a dead heat', () => {
    const story = buildStoryboard({
      games: [game({ index: 0, result: '1/2-1/2' })],
      names,
      totalGames: 1,
      url: 'u',
    })
    expect(story.outro.lines[0].text).toBe('0½ – 0½')
    expect(story.outro.lines[1].text).toBe('DEAD HEAT AFTER 1')
  })

  test('keeps a game whose PGN will not parse, minus its moves', () => {
    const story = buildStoryboard({
      games: [game({ pgn: 'total nonsense', plies: 42, reason: 'checkmate' })],
      names,
      totalGames: 1,
      url: 'u',
    })
    expect(story.totalPlies).toBe(0)
    expect(story.games[0].outro.lines.map((l) => l.text)).toContain('checkmate · 21 moves')
  })

  test('tints each line with the player it belongs to', () => {
    const story = built()
    const intro = story.intro.lines
    expect(intro.find((l) => l.text === 'ALPHA')?.tone).toBe('p0')
    expect(intro.find((l) => l.text === 'BETA')?.tone).toBe('p1')
  })
})
