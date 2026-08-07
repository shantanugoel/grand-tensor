import { describe, expect, test } from 'bun:test'
import { matchFilename, postText, resultSquares, slug } from './share'
import type { Series } from './series'
import { DEFAULTS, type Settings } from './settings'

// `shareUrl` builds on the page it is running on; outside a browser, stand in
// for the deployed one.
globalThis.location = { origin: 'https://grandtensor.shantanugoel.com', pathname: '/' } as Location

const withLabels = (a: string, b: string): Settings => {
  const s = structuredClone(DEFAULTS)
  s.players[0].label = a
  s.players[1].label = b
  return s
}

/** Only the fields the share text reads — the real Series needs a live match. */
const seriesLike = (results: string[], scores: [number, number], illegal: [number, number]) =>
  ({
    games: results.map((result, i) => ({ result, white: (i % 2) as 0 | 1 })),
    stats: [{ score: scores[0], illegal: illegal[0] }, { score: scores[1], illegal: illegal[1] }],
    get leader() {
      return scores[0] === scores[1] ? null : scores[0] > scores[1] ? 0 : 1
    },
  }) as unknown as Series

describe('slug', () => {
  test('reduces a label to something a filesystem will take', () => {
    expect(slug('GPT-5.6 Luna')).toBe('gpt-5-6-luna')
    expect(slug('  DeepSeek V4 Flash  ')).toBe('deepseek-v4-flash')
    expect(slug('anthropic/claude')).toBe('anthropic-claude')
  })

  test('falls back rather than producing an empty name', () => {
    expect(slug('???')).toBe('player')
    expect(slug('')).toBe('player')
  })
})

describe('matchFilename', () => {
  test('names the card and the video the same way', () => {
    const s = withLabels('Alpha One', 'Beta Two')
    expect(matchFilename(s, 'png')).toBe('grand-tensor-alpha-one-vs-beta-two.png')
    expect(matchFilename(s, 'webm')).toBe('grand-tensor-alpha-one-vs-beta-two.webm')
  })
})

describe('resultSquares', () => {
  test('colours each game by who took it, whichever side was white', () => {
    // Games alternate colours, so a '1-0' means player 0 in game one and
    // player 1 in game two.
    const series = seriesLike(['1-0', '1-0', '1/2-1/2', '0-1'], [2, 2], [0, 0])
    expect(resultSquares(series)).toBe('🟦🟪⬜🟦')
  })
})

describe('postText', () => {
  const s = withLabels('Alpha One', 'Beta Two')

  test('leads with the winner and ends on the link', () => {
    const text = postText(seriesLike(['1-0', '1-0', '1-0', '0-1'], [3, 1], [2, 0]), s)
    const lines = text.split('\n')
    expect(lines[0]).toBe('♟ 🟦 Alpha One beat 🟪 Beta Two 3–1 over 4 games of chess. 🏆')
    expect(lines).toContain('2 illegal moves attempted along the way.')
    expect(lines.at(-1)).toContain('grandtensor.shantanugoel.com/#an=')
  })

  test('reads the score from the winner’s side when player two takes it', () => {
    const text = postText(seriesLike(['0-1', '0-1', '0-1'], [0.5, 2.5], [0, 1]), s)
    expect(text.split('\n')[0]).toBe('♟ 🟪 Beta Two beat 🟦 Alpha One 2½–½ over 3 games of chess. 🏆')
    expect(text).toContain('1 illegal move attempted')
  })

  test('calls a tie a tie, and a clean series clean', () => {
    const text = postText(seriesLike(['1/2-1/2', '1/2-1/2'], [1, 1], [0, 0]), s)
    expect(text.split('\n')[0]).toBe('♟ 🟦 Alpha One and 🟪 Beta Two finished 2 games of chess dead level, 1–1.')
    expect(text).toContain('Not one illegal move between them.')
  })

  test('stays short enough to post without being truncated', () => {
    const text = postText(seriesLike(['1-0', '0-1', '1-0'], [2, 1], [3, 1]), withLabels('Claude Opus 5', 'GPT-5.6 Luna'))
    // X counts any link as 23 characters regardless of its real length.
    const weighted = text.split('\n').at(-1)!.length - 23
    expect(text.length - weighted).toBeLessThan(280)
  })
})
