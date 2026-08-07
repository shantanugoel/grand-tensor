/** The benchmark's inputs: a fixed, reproducible set of positions to be graded on.
 *
 *  Fixed is the whole point. Comparing prompt variants across *played games* is
 *  nearly hopeless — the games diverge after the first differing move, so the two
 *  variants end up being graded on different positions and most of the measured
 *  difference is which positions each happened to visit. Holding the positions
 *  constant turns the comparison into a paired one, which is both unbiased and
 *  dramatically tighter for the same number of API calls. */

import { Chess } from 'chess.js'
import { cleanPgn } from '../prompt'
import type { Engine } from './engine'
import { toCp } from './engine'

export type Position = {
  /** Stable across regenerations with the same seed, so results can be joined. */
  id: string
  fen: string
  /** Movetext leading to this position — the prompt asks for it. */
  pgn: string
  /** SAN of the move just played, or undefined at the root. */
  lastMove?: string
  ply: number
  phase: 'opening' | 'middlegame' | 'endgame'
}

export type PositionSet = {
  seed: number
  depth: number
  generated: string
  positions: Position[]
}

/** Phase by material still on the board, not by move number — a queenless
 *  position on move 12 is an endgame regardless of what the clock says. */
function phaseOf(chess: Chess): Position['phase'] {
  const values: Record<string, number> = { q: 9, r: 5, b: 3, n: 3, p: 0, k: 0 }
  let material = 0
  for (const row of chess.board()) for (const sq of row) if (sq) material += values[sq.type] ?? 0
  if (material >= 60) return 'opening'
  return material >= 26 ? 'middlegame' : 'endgame'
}

/** mulberry32 — small, fast, and identical on every machine, which is what makes
 *  a generated set reproducible from its seed alone. */
function rng(seed: number): () => number {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6d2b79f5) >>> 0
    let t = Math.imul(a ^ (a >>> 15), 1 | a)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

const snapshot = (chess: Chess, id: string): Position => {
  const history = chess.history()
  return {
    id,
    fen: chess.fen(),
    pgn: cleanPgn(chess.pgn()),
    lastMove: history[history.length - 1],
    ply: history.length,
    phase: phaseOf(chess),
  }
}

export type SampleOptions = {
  /** Plies at which to snapshot a position. */
  atPlies?: number[]
  /** Skip positions the engine already considers decided — a model's move in a
   *  lost position tells you very little, and the huge CPLs available there are
   *  mostly noise. Requires an engine; omitted, nothing is filtered. */
  engine?: Engine
  maxAbsEval?: number
}

/** Mixed parity on purpose. Ply count decides whose turn it is, so an all-even
 *  list would grade White exclusively and never once ask a model to play Black. */
const DEFAULT_PLIES = [9, 14, 21, 28, 35, 42, 51, 60, 69, 84]

/** Positions from already-played games. This is the one to use on your own match
 *  PGNs: it grades the models on exactly the positions they actually reach. */
export async function fromPgn(pgnText: string, opts: SampleOptions = {}): Promise<Position[]> {
  const atPlies = opts.atPlies ?? DEFAULT_PLIES
  const out: Position[] = []
  // Games are separated by a blank line before the next header block; splitting
  // on the Event tag keeps single-game files (which have no headers at all) whole.
  const games = pgnText.split(/\n\s*\n(?=\[)/).filter((g) => g.trim())

  for (const [gi, game] of games.entries()) {
    const chess = new Chess()
    try {
      chess.loadPgn(game)
    } catch {
      continue // Malformed entry: skip it rather than abort the whole file.
    }
    const moves = chess.history()
    const replay = new Chess()
    for (const [i, san] of moves.entries()) {
      replay.move(san)
      if (!atPlies.includes(i + 1)) continue
      if (replay.isGameOver() || replay.moves().length < 2) continue
      const pos = snapshot(replay, `pgn-${gi}-${i + 1}`)
      if (await keep(pos, opts)) out.push(pos)
    }
  }
  return out
}

async function keep(pos: Position, opts: SampleOptions): Promise<boolean> {
  if (!opts.engine) return true
  const limit = opts.maxAbsEval ?? 1000
  try {
    return Math.abs(toCp((await opts.engine.analyse(pos.fen)).score)) <= limit
  } catch {
    return false
  }
}

export type GenerateOptions = SampleOptions & {
  seed?: number
  games?: number
  /** Random plies before the engine takes over. Variety comes from here: pure
   *  engine self-play converges on the same handful of openings every time. */
  randomOpening?: number
  /** Engine depth while generating. Kept low deliberately — these are meant to
   *  look like games real players reach, not a 40-ply-accurate correspondence
   *  game where nothing is ever hanging. */
  playDepth?: number
}

/** Builds a set by self-play from randomised openings.
 *
 *  Self-contained, so the harness works with no corpus to hand — but positions
 *  from your own match PGNs are strictly better input, because they are the
 *  distribution you actually care about. Use `fromPgn` when you have them. */
export async function generate(engine: Engine, opts: GenerateOptions = {}): Promise<PositionSet> {
  const seed = opts.seed ?? 1
  const games = opts.games ?? 12
  const openingPlies = opts.randomOpening ?? 6
  const playDepth = opts.playDepth ?? 6
  const atPlies = opts.atPlies ?? DEFAULT_PLIES
  const rand = rng(seed)
  const positions: Position[] = []

  for (let g = 0; g < games; g++) {
    const chess = new Chess()
    const target = Math.max(...atPlies)
    for (let ply = 0; ply < target; ply++) {
      if (chess.isGameOver()) break
      const legal = chess.moves()
      const san =
        ply < openingPlies
          ? legal[Math.floor(rand() * legal.length)]
          : ((await engine.analyse(chess.fen(), playDepth)).bestMove ?? legal[0])
      // The engine speaks LAN; the random opening speaks SAN. `move` takes both.
      chess.move(san)
      if (!atPlies.includes(ply + 1)) continue
      if (chess.isGameOver() || chess.moves().length < 2) continue
      const pos = snapshot(chess, `gen-${seed}-${g}-${ply + 1}`)
      if (await keep(pos, opts)) positions.push(pos)
    }
  }

  return { seed, depth: playDepth, generated: new Date().toISOString(), positions }
}

export async function save(path: string, set: PositionSet): Promise<void> {
  await Bun.write(path, JSON.stringify(set, null, 2))
}

export async function load(path: string): Promise<PositionSet> {
  return (await Bun.file(path).json()) as PositionSet
}
