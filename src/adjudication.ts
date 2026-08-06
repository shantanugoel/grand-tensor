/** Material counting, and what to do with a game that reaches the ply limit.
 *
 *  Shared by the browser (which plays the game) and the Worker (which replays
 *  the PGN and has to reach the same verdict from the same position), so it
 *  depends on nothing but chess.js. */

import { Chess, type Color } from 'chess.js'

/** Standard piece values. Kings are excluded, so a full army is worth 39 —
 *  which is what the vitality bars use as "full health". */
const VALUES: Record<string, number> = { p: 1, n: 3, b: 3, r: 5, q: 9, k: 0 }
export const MAX_MATERIAL = 39

export function material(chess: Chess, color: Color): number {
  let sum = 0
  for (const row of chess.board())
    for (const cell of row) if (cell && cell.color === color) sum += VALUES[cell.type] ?? 0
  return sum
}

/** White's material minus Black's. */
export const materialLead = (chess: Chess): number => material(chess, 'w') - material(chess, 'b')

/** How far ahead a side must be for the ply limit to be scored as a win.
 *
 *  Five is a rook, or a minor piece and two pawns — past the point where the
 *  position is arguably still a game and into the range where calling it a draw
 *  is the wrong answer. Nothing lower: a piece for a pawn is a real edge and
 *  models throw those away often enough that adjudicating on them would score
 *  noise. */
export const ADJUDICATION_MARGIN = 5

export type Verdict = { result: '1-0' | '0-1' | '1/2-1/2'; lead: number }

/** Scores a game that ran out of plies.
 *
 *  Awarding an automatic draw rewarded the side that could not be beaten rather
 *  than the side that was winning — models are bad at converting, so a queen-up
 *  position at the limit was worth the same half point as a dead-equal one. That
 *  systematically flattered weak play that merely survived, and compressed the
 *  whole rating spread with it.
 *
 *  Material is a crude judge: it does not see a fortress, a mating net, or a
 *  passed pawn about to promote. It is used anyway because it is the only
 *  verdict the Worker can recompute from a PGN without shipping an engine —
 *  and being recomputable is what keeps the result checkable rather than
 *  claimed. */
export function adjudicate(chess: Chess): Verdict {
  const lead = materialLead(chess)
  if (lead >= ADJUDICATION_MARGIN) return { result: '1-0', lead }
  if (lead <= -ADJUDICATION_MARGIN) return { result: '0-1', lead }
  return { result: '1/2-1/2', lead }
}

/** How the ending reads in the game record and the battle log. */
export function adjudicationReason(maxPlies: number, verdict: Verdict): string {
  const limit = `move limit (${maxPlies} plies)`
  if (verdict.result === '1/2-1/2') return limit
  const side = verdict.result === '1-0' ? 'White' : 'Black'
  return `${limit} — adjudicated to ${side}, +${Math.abs(verdict.lead)} material`
}
