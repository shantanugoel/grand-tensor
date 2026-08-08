/** What a verdict on a move is, and how it reads.
 *
 *  The numbers all come from a real search now (`browser-engine.ts`), so this is
 *  only the vocabulary: the bands, the wording, and the compact form a verdict
 *  takes when it is stored beside the game it belongs to.
 *
 *  It replaced a client-side evaluator that produced these numbers itself. That
 *  evaluator was worth its keep only while there was nothing better; a search
 *  reads a sacrifice, a recapture and a mating net natively, and none of the
 *  machinery that used to compensate for not being able to survives here.
 *
 *  Pure, DOM-free and three.js-free: the battle log, the arena and the video
 *  replay all read the same numbers out of here. */

/** What a mate on the board scores. Far outside anything a real position can
 *  produce, so it sorts above everything without a separate code path. */
export const MATE_CP = 30_000

export type EvalTag = 'mate' | 'best' | 'good' | 'inaccuracy' | 'mistake' | 'blunder' | 'catastrophe'

export type MoveEval = {
  /** The position after the move, white's point of view. */
  cp: number
  mate: boolean
  draw: boolean
  /** Centipawns the mover gave up against the engine's own choice. Never
   *  negative: both moves are searched from the same node at the same depth, so
   *  a move cannot beat the search that judged it. */
  loss: number
  tag: EvalTag
}

/** Lichess-style bands, widened at the top for an arcade that wants a word for
 *  "this did not cost a piece, it cost the game".
 *
 *  Blunter than the offline harness's thresholds on purpose: those grade a model
 *  over hundreds of positions, where 50cp is a real signal. This one interrupts
 *  a fight with a label, and a label on every move is a label on none of them. */
const CATASTROPHE = 600
const BLUNDER = 300
const MISTAKE = 150
const INACCURACY = 70

export function classifyLoss(loss: number): EvalTag {
  if (loss >= CATASTROPHE) return 'catastrophe'
  if (loss >= BLUNDER) return 'blunder'
  if (loss >= MISTAKE) return 'mistake'
  if (loss >= INACCURACY) return 'inaccuracy'
  return loss <= 20 ? 'best' : 'good'
}

/** A verdict as it is stored: the score after the move and what the move cost,
 *  both in centipawns, and nothing else.
 *
 *  Two numbers rather than the whole `MoveEval` because a series keeps up to
 *  thirty matches of a couple of hundred plies each in localStorage, and the
 *  rest of the verdict is derivable — the tag from the loss, mate and draw from
 *  the board the replay is already standing on. */
export type StoredEval = [cp: number, loss: number]

export const storeEval = (verdict: MoveEval): StoredEval => [Math.round(verdict.cp), Math.round(verdict.loss)]

/** Reads a stored verdict back, given what the position it produced turned out
 *  to be. `mover` is whose move it was, so a mate can be scored for the side
 *  that delivered it. */
export function readEval(
  stored: StoredEval,
  ended: { mate: boolean; draw: boolean },
  mover: 'w' | 'b',
): MoveEval {
  const [cp, loss] = stored
  if (ended.mate) return { cp: mover === 'w' ? MATE_CP : -MATE_CP, mate: true, draw: false, loss: 0, tag: 'mate' }
  return { cp: ended.draw ? 0 : cp, mate: false, draw: ended.draw, loss, tag: classifyLoss(loss) }
}

/* ---------- how it reads ---------- */

/** The score the way a broadcast prints it: signed pawns to two places, from
 *  white's point of view. */
export function fmtEval(read: Pick<MoveEval, 'cp' | 'mate' | 'draw'>): string {
  if (read.mate) return 'MATE'
  if (read.draw) return 'DRAW'
  const pawns = read.cp / 100
  if (Math.abs(pawns) < 0.005) return '0.00'
  return `${pawns > 0 ? '+' : '−'}${Math.abs(pawns).toFixed(2)}`
}

/** A swing in pawns, signed the way a scoreboard reads it: what the move cost
 *  its own player, so a blunder is negative. */
export const fmtSwing = (loss: number): string =>
  `${loss > 0 ? '−' : '+'}${Math.abs(loss / 100).toFixed(1)}`

/** Battle-log wording. `best` and `good` say nothing: a verdict on every single
 *  move is a verdict on none of them, and most moves are neither. */
export const TAG_LABEL: Record<EvalTag, string> = {
  mate: 'MATE',
  best: '',
  good: '',
  inaccuracy: 'INACCURACY',
  mistake: 'MISTAKE',
  blunder: 'BLUNDER',
  catastrophe: 'CATASTROPHIC',
}

/** Arcade wording for the same verdicts, thrown up over the board. Only the
 *  ones worth interrupting the fight for have any — `mate` included, since the
 *  board already shouts CHECKMATE at itself. */
export const TAG_SHOUT: Record<EvalTag, string[]> = {
  mate: [],
  best: [],
  good: [],
  inaccuracy: [],
  mistake: ['MISTAKE!', 'SHAKY!', 'LOOSE!'],
  blunder: ['BLUNDER!', 'FUMBLE!', 'THROWN!'],
  catastrophe: ['DISASTER!', 'MELTDOWN!', 'IMPLOSION!'],
}

/** How loud each verdict is, for deciding which of two that land within a
 *  second of each other gets the board to itself. */
export const TAG_VOLUME: Record<EvalTag, number> = {
  mate: 0,
  best: 0,
  good: 0,
  inaccuracy: 0,
  mistake: 1,
  blunder: 3,
  catastrophe: 4,
}

export const TAG_COLOR: Record<EvalTag, string> = {
  mate: '#ffd54a',
  best: '#7d8bb5',
  good: '#7d8bb5',
  inaccuracy: '#ffd54a',
  mistake: '#ffa14a',
  blunder: '#ff5b5b',
  catastrophe: '#ff2f6d',
}
