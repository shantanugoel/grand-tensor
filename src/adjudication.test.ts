import { describe, expect, test } from 'bun:test'
import { Chess } from 'chess.js'
import { ADJUDICATION_MARGIN, adjudicate, adjudicationReason, material, materialLead, MAX_MATERIAL } from './adjudication'

/** Positions are built by FEN so the count is obvious from the setup. Black is
 *  always to move, which is irrelevant to a material verdict — and proving that
 *  is part of the point. */
const at = (fen: string) => new Chess(fen)

describe('material', () => {
  test('a full army is a full bar', () => {
    const start = new Chess()
    expect(material(start, 'w')).toBe(MAX_MATERIAL)
    expect(material(start, 'b')).toBe(MAX_MATERIAL)
    expect(materialLead(start)).toBe(0)
  })

  test('excludes kings, so a bare-kings position is level at zero', () => {
    expect(material(at('4k3/8/8/8/8/8/8/4K3 b - - 0 1'), 'w')).toBe(0)
    expect(materialLead(at('4k3/8/8/8/8/8/8/4K3 b - - 0 1'))).toBe(0)
  })
})

describe('adjudicate', () => {
  test('draws a level position at the limit', () => {
    expect(adjudicate(at('4k3/8/8/8/8/8/4P3/4K3 b - - 0 1')).result).toBe('1/2-1/2')
  })

  test('draws a position inside the margin, however won it looks', () => {
    // A whole bishop up, and still a draw: below the margin on purpose, because
    // models throw away a minor piece often enough to make it noise.
    const lead = at('4k3/8/8/8/8/8/8/2B1K3 b - - 0 1')
    expect(materialLead(lead)).toBe(3)
    expect(materialLead(lead)).toBeLessThan(ADJUDICATION_MARGIN)
    expect(adjudicate(lead).result).toBe('1/2-1/2')
  })

  test('awards the point once a side is a rook or better ahead', () => {
    const rookUp = at('4k3/8/8/8/8/8/8/R3K3 b - - 0 1')
    expect(materialLead(rookUp)).toBe(ADJUDICATION_MARGIN)
    expect(adjudicate(rookUp)).toEqual({ result: '1-0', lead: 5 })

    const queenDown = at('3qk3/8/8/8/8/8/8/4K3 b - - 0 1')
    expect(adjudicate(queenDown)).toEqual({ result: '0-1', lead: -9 })
  })

  test('names the winner and the margin in the game record', () => {
    expect(adjudicationReason(200, { result: '1-0', lead: 7 })).toBe(
      'move limit (200 plies) — adjudicated to White, +7 material',
    )
    expect(adjudicationReason(200, { result: '0-1', lead: -9 })).toBe(
      'move limit (200 plies) — adjudicated to Black, +9 material',
    )
    // A drawn adjudication reads exactly as it always did, which is what keeps
    // submissionReason's "move limit (" prefix match working.
    expect(adjudicationReason(200, { result: '1/2-1/2', lead: 1 })).toBe('move limit (200 plies)')
  })
})
