/** Grading a single move: how much worse than best was it?
 *
 *  Centipawn loss is the standard measure and it is the one thing this arena
 *  currently cannot see. Win/loss over four games says almost nothing at this
 *  sample size; average CPL over a few hundred graded moves says a great deal,
 *  and it says it about each move rather than each game. */

import { Chess } from 'chess.js'
import { toCp, type Analysis, type Engine } from './engine'

/** Lichess-style bands. The thresholds are conventional rather than derived, but
 *  they are the ones every chess player already has intuitions about. */
export type Severity = 'best' | 'good' | 'inaccuracy' | 'mistake' | 'blunder'

export function classify(cpl: number): Severity {
  if (cpl < 10) return 'best'
  if (cpl < 50) return 'good'
  if (cpl < 100) return 'inaccuracy'
  if (cpl < 300) return 'mistake'
  return 'blunder'
}

/** A mate that got missed can produce a five-figure loss, and one of those in a
 *  sample drags the mean somewhere no amount of ordinary play can pull it back
 *  from. Capping keeps the average a summary of typical play; `rawCpl` keeps the
 *  uncapped number for anyone who wants it. */
export const CPL_CAP = 1000

export type MoveGrade = {
  /** Centipawns lost against the engine's choice, capped at CPL_CAP. */
  cpl: number
  rawCpl: number
  severity: Severity
  /** SAN of the engine's preferred move. */
  best: string | null
  /** Score of the engine's move, side-to-move relative. */
  bestCp: number
  /** Score of the move actually played, same node and depth. */
  playedCp: number
}

/** Converts SAN to the long algebraic form UCI wants, and rejects anything the
 *  position doesn't allow — a grader must never quietly score an illegal move. */
export function toUci(fen: string, san: string): string | null {
  const chess = new Chess(fen)
  const hit = chess.moves({ verbose: true }).find((m) => m.san === san)
  return hit ? hit.lan : null
}

/** Grades one move in one position.
 *
 *  Two searches, both rooted at `fen`: an unrestricted one for the best move and
 *  a `searchmoves`-restricted one for the move played. Same node, same depth, so
 *  the difference is attributable to the move rather than to search asymmetry. */
export async function gradeMove(
  engine: Engine,
  fen: string,
  san: string,
  depth?: number,
  bestOverride?: Analysis,
): Promise<MoveGrade> {
  const uci = toUci(fen, san)
  if (!uci) throw new Error(`"${san}" is not legal in ${fen}`)

  const bestAnalysis = bestOverride ?? (await engine.analyse(fen, depth))
  const bestCp = toCp(bestAnalysis.score)

  // If the engine's own pick is the move played, the restricted search is the
  // same search — skip it. On a strong model that is a large share of the moves,
  // and it roughly halves the engine time for the run.
  const playedCp =
    bestAnalysis.bestMove === uci ? bestCp : toCp((await engine.analyse(fen, depth, uci)).score)

  // Negative loss means the restricted search happened to see slightly further
  // in a narrower tree. It is search noise, not a move that beat the engine.
  const rawCpl = Math.max(0, bestCp - playedCp)

  const chess = new Chess(fen)
  const bestSan = bestAnalysis.bestMove
    ? (chess.moves({ verbose: true }).find((m) => m.lan === bestAnalysis.bestMove)?.san ?? null)
    : null

  return {
    cpl: Math.min(rawCpl, CPL_CAP),
    rawCpl,
    severity: classify(rawCpl),
    best: bestSan,
    bestCp,
    playedCp,
  }
}

/** A grader that remembers the best move it found for each position.
 *
 *  Every model and every prompt variant is graded on the same position list, so
 *  the unrestricted search is the same search each time — worth doing once. On a
 *  two-model, two-variant run that removes three quarters of the full searches. */
export class Grader {
  private best = new Map<string, Promise<Analysis>>()

  constructor(
    private engine: Engine,
    private depth?: number,
  ) {}

  /** Memoised on the promise rather than the result, so concurrent callers on a
   *  cold entry share one search instead of racing to duplicate it. */
  private bestFor(fen: string): Promise<Analysis> {
    let pending = this.best.get(fen)
    if (!pending) {
      pending = this.engine.analyse(fen, this.depth)
      this.best.set(fen, pending)
    }
    return pending
  }

  async grade(fen: string, san: string): Promise<MoveGrade> {
    return gradeMove(this.engine, fen, san, this.depth, await this.bestFor(fen))
  }

  /** Warms the cache so a run reports engine time and model time separately
   *  rather than interleaving them into one opaque total. */
  async prime(fens: string[]): Promise<void> {
    for (const fen of fens) await this.bestFor(fen)
  }
}
