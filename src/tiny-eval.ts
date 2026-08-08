/** A tiny engine-flavoured evaluation, for commentary rather than for play.
 *
 *  `src/eval/` drives a real Stockfish over stdio, which is exactly right for
 *  grading a benchmark offline and exactly wrong here: the browser has no engine
 *  binary, the page's CSP has no `wasm-unsafe-eval`, and a match is a spectacle
 *  running next to a 3D scene. So this is a classical evaluator in Stockfish's
 *  *shape* — tapered material, piece-square tables, a handful of pawn, rook and
 *  king-safety terms, one ply of "what is hanging?" — and nothing in its class:
 *  no search, no transposition table, no tuning. A call is a few sweeps of 64
 *  squares and costs tens of microseconds, against turns that take minutes and
 *  video frames with tens of milliseconds to spare.
 *
 *  What it buys is the thing the battle log could not say before: which move was
 *  the one that threw the game away. Read it as colour commentary. It cannot see
 *  a mating net, a fortress or a three-move combination, and it will happily
 *  call a real sacrifice a blunder — which is also true of the vitality bars,
 *  and nobody minds those either.
 *
 *  Nothing here decides a game: the result, the adjudication and the leaderboard
 *  all still run on `adjudication.ts`, which the Worker can recompute. This is
 *  the client's own show and never leaves the browser.
 *
 *  Pure, DOM-free and three.js-free: the battle log, the arena and the video
 *  replay all read the same numbers out of here. */

import type { Chess, Color, Move, PieceSymbol } from 'chess.js'

type Board = ReturnType<Chess['board']>

/* ---------- the tables ----------
   Generated from rules rather than pasted out of a tuner, because a rule can be
   read and argued with. The scale is centipawns from the point of view of the
   side that owns the piece, and every table is written for white — black reads
   the same table through a mirrored rank. */

const FILES = 8
const RANKS = 8

/** 0 at the four centre squares, growing to 3 in the corners. */
const centreDist = (file: number, rank: number) =>
  Math.max(Math.abs(file - 3.5), Math.abs(rank - 3.5)) - 0.5

/** Midgame and endgame piece values. Pawns gain as promotion gets closer,
 *  knights lose a little on an emptying board, rooks and queens gain as the
 *  lines open. */
const VALUE_MG: Record<PieceSymbol, number> = { p: 100, n: 320, b: 335, r: 500, q: 950, k: 0 }
const VALUE_EG: Record<PieceSymbol, number> = { p: 125, n: 300, b: 330, r: 545, q: 1000, k: 0 }

/** Weighted towards the pieces whose disappearance actually ends a middlegame;
 *  24 is a full board and 0 is bare kings. */
const PHASE: Record<PieceSymbol, number> = { p: 0, n: 1, b: 1, r: 2, q: 4, k: 0 }
const MAX_PHASE = 24

type Table = number[]

/** file + rank * 8, white's a1 at 0 — the order every table below is built in. */
const idx = (file: number, rank: number) => rank * FILES + file

function table(score: (file: number, rank: number) => number): Table {
  const out: Table = new Array(64)
  for (let rank = 0; rank < RANKS; rank++)
    for (let file = 0; file < FILES; file++) out[idx(file, rank)] = Math.round(score(file, rank))
  return out
}

const PST_MG: Record<PieceSymbol, Table> = {
  // Pawns want the centre files and want to be off their start square. The d
  // and e pawns are penalised for still sitting on rank 2, which is what makes
  // 1.e4 and 1.d4 look better than 1.a3.
  p: table((f, r) => {
    if (r === 0 || r === 7) return 0
    const centre = f === 3 || f === 4 ? 14 : f === 2 || f === 5 ? 6 : 0
    const advance = [0, -6, 0, 6, 16, 30, 50, 0][r]
    const blocked = r === 1 && (f === 3 || f === 4) ? -18 : 0
    return advance + centre + blocked
  }),
  // Knights are the most centralisation-hungry piece on the board, and the rim
  // really is grim: a corner knight reaches two squares.
  n: table((f, r) => -28 + 16 * (3 - centreDist(f, r)) + (r >= 3 && r <= 5 ? 8 : 0)),
  // Bishops want long diagonals, so this is a penalty for the edge rather than a
  // bonus for the middle, plus a nudge off the back rank.
  b: table((f, r) => -14 + 7 * (3 - centreDist(f, r)) + (r === 0 ? -6 : 4)),
  // Which file a rook stands on is judged dynamically further down; the table
  // only knows about the seventh rank, where a rook eats.
  r: table((f, r) => (r === 6 ? 22 : r === 7 ? 8 : 0) + (f === 3 || f === 4 ? 6 : 0)),
  // Barely any shape at all. An early queen is a liability no table can measure,
  // so this one says almost nothing and lets material speak.
  q: table((f, r) => 3 * (3 - centreDist(f, r)) + (r === 0 ? 2 : 0)),
  // Castled and behind pawns, or punished. The two peaks are g1 and c1.
  k: table((f, r) => {
    if (r > 2) return -50 - 10 * r
    const shelter = r === 0 ? 0 : r === 1 ? -22 : -40
    const corner = f === 6 || f === 2 ? 26 : f === 7 || f === 1 || f === 0 ? 14 : f === 3 ? -6 : -14
    return shelter + corner
  }),
}

const PST_EG: Record<PieceSymbol, Table> = {
  // In an endgame a pawn is worth what its promotion square is worth, and the
  // file it stands on stops mattering.
  p: table((_f, r) => (r === 0 || r === 7 ? 0 : [0, 0, 8, 22, 44, 78, 130, 0][r])),
  n: table((f, r) => -22 + 12 * (3 - centreDist(f, r))),
  b: table((f, r) => -8 + 5 * (3 - centreDist(f, r))),
  r: table((_f, r) => (r === 6 ? 14 : 0)),
  q: table((f, r) => 6 * (3 - centreDist(f, r))),
  // The king stops hiding and starts working.
  k: table((f, r) => -34 + 14 * (3 - centreDist(f, r))),
}

/** Passed pawns, by the rank they stand on counted from their own side. Worth
 *  little in the middlegame and often the whole game in the endgame. */
const PASSED_MG = [0, 4, 8, 16, 30, 52, 80, 0]
const PASSED_EG = [0, 10, 18, 34, 62, 104, 160, 0]

const BISHOP_PAIR_MG = 28
const BISHOP_PAIR_EG = 48
const DOUBLED_MG = -11
const DOUBLED_EG = -24
const ISOLATED_MG = -14
const ISOLATED_EG = -18
const ROOK_OPEN_MG = 24
const ROOK_SEMI_MG = 11
/** Per friendly pawn one or two ranks in front of the king, on its file or a
 *  neighbouring one. The term that makes castling pay. */
const SHIELD_MG = 10

/** What a mate on the board scores. Far outside anything a real position can
 *  produce, so it sorts above everything without a separate code path. */
export const MATE_CP = 30_000

/* ---------- the evaluation ---------- */

/** A position's score, always from white's point of view: positive is good for
 *  white, whoever happens to be to move. */
export type EvalRead = {
  cp: number
  /** Checkmate is on the board — `cp` is ±MATE_CP. */
  mate: boolean
  /** Drawn and over: stalemate, insufficient material or the fifty-move rule.
   *  Scored 0, but it is a different 0. */
  draw: boolean
}

const bit = (rank: number) => 1 << rank

export function evaluate(chess: Chess): EvalRead {
  if (chess.isCheckmate()) return { cp: chess.turn() === 'w' ? -MATE_CP : MATE_CP, mate: true, draw: false }
  // Deliberately not `isGameOver()`: that one also asks about threefold
  // repetition, which chess.js answers by replaying the whole game. The series
  // owns the actual result; this only needs to stop scoring a finished board as
  // if it were a position.
  if (chess.isStalemate() || chess.isInsufficientMaterial() || chess.isDrawByFiftyMoves())
    return { cp: 0, mate: false, draw: true }

  const board = chess.board()
  let mg = 0
  let eg = 0
  let phase = 0

  // The pawn skeleton first: it drives the doubled, isolated, passed, rook-file
  // and king-shelter terms, every one of which would otherwise want its own
  // sweep of the board. Each file is a bitmask of the ranks that side has a pawn
  // on, counted from its own end, so both colours read the same way.
  const pawnMask: Record<Color, number[]> = { w: new Array(FILES).fill(0), b: new Array(FILES).fill(0) }
  const pawnCount: Record<Color, number[]> = { w: new Array(FILES).fill(0), b: new Array(FILES).fill(0) }
  const bishops: Record<Color, number> = { w: 0, b: 0 }

  for (let row = 0; row < RANKS; row++) {
    for (let file = 0; file < FILES; file++) {
      const cell = board[row][file]
      if (!cell) continue
      if (cell.type === 'b') bishops[cell.color]++
      if (cell.type !== 'p') continue
      const own = cell.color === 'w' ? 7 - row : row
      pawnMask[cell.color][file] |= bit(own)
      pawnCount[cell.color][file]++
    }
  }

  for (let row = 0; row < RANKS; row++) {
    for (let file = 0; file < FILES; file++) {
      const cell = board[row][file]
      if (!cell) continue
      const white = cell.color === 'w'
      const them: Color = white ? 'b' : 'w'
      // Rank from this side's own end, which is also how it reads the tables.
      const own = white ? 7 - row : row
      const at = idx(file, own)
      const sign = white ? 1 : -1

      phase += PHASE[cell.type]
      let pieceMg = VALUE_MG[cell.type] + PST_MG[cell.type][at]
      let pieceEg = VALUE_EG[cell.type] + PST_EG[cell.type][at]

      if (cell.type === 'p') {
        if (pawnCount[cell.color][file] > 1) {
          pieceMg += DOUBLED_MG
          pieceEg += DOUBLED_EG
        }
        if ((pawnMask[cell.color][file - 1] ?? 0) === 0 && (pawnMask[cell.color][file + 1] ?? 0) === 0) {
          pieceMg += ISOLATED_MG
          pieceEg += ISOLATED_EG
        }
        // Passed: no enemy pawn on this file or either neighbour is still in
        // front of it. An enemy pawn at their own rank `r` stands `7 - r` from
        // our end, so everything ahead of us is their bits below `7 - own`.
        const ahead = bit(7 - own) - 1
        const blocked = [file - 1, file, file + 1].some((f) => ((pawnMask[them][f] ?? 0) & ahead) !== 0)
        if (!blocked) {
          pieceMg += PASSED_MG[own]
          pieceEg += PASSED_EG[own]
        }
      } else if (cell.type === 'r') {
        if (pawnCount[cell.color][file] === 0)
          pieceMg += pawnCount[them][file] === 0 ? ROOK_OPEN_MG : ROOK_SEMI_MG
      } else if (cell.type === 'k') {
        const shelter = bit(own + 1) | bit(own + 2)
        let shield = 0
        for (let f = Math.max(0, file - 1); f <= Math.min(FILES - 1, file + 1); f++)
          if ((pawnMask[cell.color][f] & shelter) !== 0) shield++
        pieceMg += shield * SHIELD_MG
      } else if (cell.type === 'b' && bishops[cell.color] >= 2) {
        // The bishop pair, paid half at a time: charging it per bishop keeps the
        // sweep single-pass, and two halves is the pair.
        pieceMg += BISHOP_PAIR_MG / 2
        pieceEg += BISHOP_PAIR_EG / 2
      }

      mg += sign * pieceMg
      eg += sign * pieceEg
    }
  }

  // Tapered: interpolate between the two evaluations on how much material is
  // left, so a rook's endgame value arrives gradually rather than the moment
  // some threshold is crossed.
  const weight = Math.min(phase, MAX_PHASE) / MAX_PHASE
  const positional = mg * weight + eg * (1 - weight)

  // Only the side to move's loose material counts, because only the side to
  // move can actually take it. A piece under attack with its owner on the clock
  // is not lost — it walks away — which is why this is asked of one side and not
  // netted between them.
  const white = chess.turn() === 'w'
  const threat = loose(chess, board)[white ? 'w' : 'b']
  return {
    cp: Math.round(positional + (white ? 1 : -1) * THREAT_WEIGHT * threat),
    mate: false,
    draw: false,
  }
}

const SEE_VALUE: Record<PieceSymbol, number> = { p: 100, n: 320, b: 335, r: 500, q: 950, k: 20_000 }

/** How much of the loose material in front of the side to move is counted as
 *  already won.
 *
 *  Most of it, but not all: a discount, because this sees one ply and a defender
 *  it cannot count may well be a defender that matters. It is also the number
 *  the verdict bands are calibrated against — leave a knight hanging and the log
 *  calls it a mistake, a rook a blunder, a queen a catastrophe. */
const THREAT_WEIGHT = 0.7

/** The best material each side has lying loose in front of it, whether or not it
 *  is their turn. `evaluate` uses one half of this; the other half is what makes
 *  it cheap to ask.
 *
 *  A static evaluation is blind in exactly the way this arena cannot afford: the
 *  most common thing a language model does over a board is leave a queen en
 *  prise, and to a piece-square table that position looks perfectly level right
 *  up until the capture is played. One ply of "what is hanging?" is what puts
 *  the verdict on the move that hung it rather than on the move that took it.
 *
 *  The exchange arithmetic is shallow — the victim, minus the cheapest attacker
 *  if the square is defended at all — so a pawn defended three times is not
 *  worked out properly, and a pin, an overloaded defender or a capture that is
 *  illegal because the king is in check are all invisible. That is the trade
 *  this whole file makes. */
function loose(chess: Chess, board: Board): { w: number; b: number } {
  const best = { w: 0, b: 0 }
  for (let row = 0; row < RANKS; row++) {
    for (let file = 0; file < FILES; file++) {
      const cell = board[row][file]
      // Kings are not won, they are mated, and pricing one at 20,000 would make
      // every check the end of the world.
      if (!cell || cell.type === 'k') continue
      const them: Color = cell.color === 'w' ? 'b' : 'w'
      const square = cell.square
      const attackers = chess.attackers(square, them)
      if (attackers.length === 0) continue

      let cheapest = Infinity
      for (const from of attackers) {
        const piece = chess.get(from)
        if (piece) cheapest = Math.min(cheapest, SEE_VALUE[piece.type])
      }
      // A defended piece costs its attacker; an undefended one is simply free.
      const defended = chess.attackers(square, cell.color).length > 0
      const net = SEE_VALUE[cell.type] - (defended ? cheapest : 0)
      if (net > best[them]) best[them] = net
    }
  }
  return best
}

/* ---------- judging a move ---------- */

/** Lichess's vocabulary, plus the ends an arcade needs: `brilliant` for a move
 *  that wins material outright, `catastrophe` for one that loses a game rather
 *  than a piece, `mate` for the one that ends it — and `quiet` for a move this
 *  evaluation has decided it is not qualified to have an opinion about. */
export type EvalTag =
  | 'mate'
  | 'brilliant'
  | 'best'
  | 'good'
  | 'quiet'
  | 'inaccuracy'
  | 'mistake'
  | 'blunder'
  | 'catastrophe'

export type MoveEval = {
  /** The position after the move, white's point of view. */
  cp: number
  mate: boolean
  draw: boolean
  /** Centipawns the mover gave up. Negative means the move gained ground —
   *  usually because the opponent had just left something hanging. */
  loss: number
  tag: EvalTag
}

/** Thresholds are blunter than a real engine's, because this evaluation is
 *  shallow enough that a 60cp wobble is as likely to be the tables disagreeing
 *  with themselves as it is a mistake.
 *
 *  They are set against what THREAT_WEIGHT makes a hung piece worth, so the
 *  bands land on the thing a spectator actually sees: hang a pawn and it is an
 *  inaccuracy, a knight a mistake, a rook a blunder, a queen a catastrophe. */
const CATASTROPHE = 600
const BLUNDER = 300
const MISTAKE = 150
const INACCURACY = 70
const BRILLIANT = 250

export function classifyLoss(loss: number): EvalTag {
  if (loss <= -BRILLIANT) return 'brilliant'
  // A hung queen and up. Past this the move did not cost material, it cost the
  // game, and the log should say so in a different word.
  if (loss >= CATASTROPHE) return 'catastrophe'
  if (loss >= BLUNDER) return 'blunder'
  if (loss >= MISTAKE) return 'mistake'
  if (loss >= INACCURACY) return 'inaccuracy'
  return loss <= 20 ? 'best' : 'good'
}

/** What one move did, given the evaluation either side of it.
 *
 *  Both reads are white's point of view, so the mover's ledger is the same
 *  number with the sign flipped for black. Mate is its own category: how many
 *  centipawns checkmate gained over the previous position is arithmetic nobody
 *  wants to read. */
export function judgeMove(before: EvalRead, after: EvalRead, mover: Color): MoveEval {
  const sign = mover === 'w' ? 1 : -1
  // A move can only ever mate the other side — you cannot walk into checkmate —
  // so a mate on the board after the move belongs to whoever just moved.
  const delivered = after.mate && after.cp * sign > 0
  // Stalemate is deliberately not exempt: agreeing to nothing from a winning
  // position is one of the loudest blunders in chess, and this is the measure
  // that catches it.
  const loss = delivered ? 0 : (before.cp - after.cp) * sign
  return {
    cp: after.cp,
    mate: after.mate,
    draw: after.draw,
    loss,
    tag: delivered ? 'mate' : classifyLoss(loss),
  }
}

/** Follows one game and judges each move as it lands.
 *
 *  The state it keeps is what separates a verdict worth printing from one worth
 *  swallowing. A one-ply evaluation is at its worst inside a forcing sequence:
 *  every sacrifice reads as a catastrophe, every recapture as a brilliancy, and
 *  a queen sacrifice that mates in three gets the loudest label in the file for
 *  being the best move on the board. Rather than pretend otherwise, moves it
 *  cannot read are declared unjudged — checks, replies to check, and recaptures
 *  on the square the last move landed on. The score is still recorded; only the
 *  opinion is withheld.
 *
 *  What survives the filter is what this evaluation is genuinely good at, and
 *  what a language model does constantly: leaving something loose in a quiet
 *  position, and walking past something loose the opponent left. */
export class Commentator {
  private read: EvalRead = { cp: 0, mate: false, draw: false }
  private lastTo: string | null = null
  /** Whether the side about to move is in check — recorded before their move,
   *  since by the time it has been played the board no longer says so. */
  private facingCheck = false

  /** Points the commentator at a board that was dealt or restored rather than
   *  played into. Must come before the first `judge` on that board. */
  reset(chess: Chess): void {
    this.read = evaluate(chess)
    this.lastTo = null
    this.facingCheck = chess.isCheck()
  }

  /** Judges the move that produced `chess`, which is the position after it. */
  judge(chess: Chess, move: Move): MoveEval {
    const before = this.read
    this.read = evaluate(chess)
    const verdict = judgeMove(before, this.read, move.color)

    const forced = this.facingCheck
    const recapture = Boolean(move.captured) && move.to === this.lastTo
    const forcing = chess.isCheck()
    this.lastTo = move.to
    this.facingCheck = forcing

    if (verdict.tag === 'mate' || !(forced || forcing || recapture)) return verdict
    return { ...verdict, tag: 'quiet' }
  }
}

/* ---------- how it reads ---------- */

/** The score the way a broadcast prints it: signed pawns to two places, from
 *  white's point of view. */
export function fmtEval(read: Pick<EvalRead, 'cp' | 'mate' | 'draw'>): string {
  if (read.mate) return 'MATE'
  if (read.draw) return 'DRAW'
  const pawns = read.cp / 100
  if (Math.abs(pawns) < 0.005) return '0.00'
  return `${pawns > 0 ? '+' : '−'}${Math.abs(pawns).toFixed(2)}`
}

/** A swing in pawns, signed the way a scoreboard reads it: what the move cost
 *  its own player, so a blunder is negative and a punishment is positive. */
export const fmtSwing = (loss: number): string =>
  `${loss > 0 ? '−' : '+'}${Math.abs(loss / 100).toFixed(1)}`

/** Battle-log wording. `best` and `good` say nothing: a verdict on every single
 *  move is a verdict on none of them, and most moves are neither. */
export const TAG_LABEL: Record<EvalTag, string> = {
  mate: 'MATE',
  brilliant: 'CRUSHING',
  best: '',
  good: '',
  quiet: '',
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
  brilliant: ['CRUSHING!', 'RUTHLESS!', 'SAVAGE!'],
  best: [],
  good: [],
  quiet: [],
  inaccuracy: [],
  mistake: ['MISTAKE!', 'SHAKY!', 'LOOSE!'],
  blunder: ['BLUNDER!', 'FUMBLE!', 'THROWN!'],
  catastrophe: ['DISASTER!', 'MELTDOWN!', 'IMPLOSION!'],
}

/** How loud each verdict is, for deciding which of two that land within a
 *  second of each other gets the board to itself. */
export const TAG_VOLUME: Record<EvalTag, number> = {
  mate: 0,
  brilliant: 2,
  best: 0,
  good: 0,
  quiet: 0,
  inaccuracy: 0,
  mistake: 1,
  blunder: 3,
  catastrophe: 4,
}

export const TAG_COLOR: Record<EvalTag, string> = {
  mate: '#ffd54a',
  brilliant: '#5cffa8',
  best: '#7d8bb5',
  good: '#7d8bb5',
  quiet: '#7d8bb5',
  inaccuracy: '#ffd54a',
  mistake: '#ffa14a',
  blunder: '#ff5b5b',
  catastrophe: '#ff2f6d',
}
