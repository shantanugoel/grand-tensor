import { describe, expect, test } from 'bun:test'
import { submissionReason } from './leaderboard-protocol'

describe('submissionReason', () => {
  test('keeps the two forfeit causes apart', () => {
    // One is a chess failure. The other says the completion budget is too small
    // for how that model thinks, which is a fact about the circuit, not the model.
    expect(submissionReason('Alpha forfeits (illegal moves)')).toBe('illegal_forfeit')
    expect(submissionReason('Alpha forfeits (token cap)')).toBe('cap_forfeit')
  })

  test('maps the board endings the series actually writes', () => {
    expect(submissionReason('checkmate')).toBe('checkmate')
    expect(submissionReason('insufficient material')).toBe('insufficient_material')
    expect(submissionReason('fifty-move rule')).toBe('fifty_move_rule')
    expect(submissionReason('move limit (200 plies)')).toBe('move_limit')
    // Adjudicated move-limit endings keep the prefix, so they map the same way.
    expect(submissionReason('move limit (200 plies) — adjudicated to White, +7 material')).toBe('move_limit')
  })

  test('refuses an ending it does not recognise rather than guessing', () => {
    expect(submissionReason('resignation')).toBeNull()
  })
})
