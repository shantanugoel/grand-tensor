/** A UCI engine driven over a line-oriented transport.
 *
 *  Deliberately not a general UCI client — it does exactly what grading a move
 *  needs: set a position, search to a fixed depth, report the score. Fixed depth
 *  rather than fixed time, because a benchmark that changes its mind depending on
 *  how busy the laptop was is not a benchmark.
 *
 *  The transport is an interface rather than a spawned process so the same UCI
 *  layer can drive a native binary over stdio (the harness) and a wasm build over
 *  worker postMessage (the browser). Nothing below this comment knows which. */

const MATE_CP = 10_000

/** A score from the point of view of the side to move.
 *
 *  `mate` is signed plies-to-mate, kept alongside the centipawn value so callers
 *  can tell a real +900 from a forced mate that got flattened into one. */
export type Score = { cp: number; mate: number | null }

export type Analysis = { score: Score; bestMove: string | null; depth: number }

/** Engine-relative scores are only comparable after both are put on the same
 *  side's books. Every score this module returns is side-to-move relative, so
 *  comparing across a move means negating exactly once. */
export const negate = (s: Score): Score => ({ cp: -s.cp, mate: s.mate === null ? null : -s.mate })

/** Mate scores have no centipawn value, but a grader has to rank them against
 *  ordinary ones. Mapping them just outside the normal range preserves the
 *  ordering (mate in 1 beats mate in 5 beats +2000) without letting the raw
 *  magnitude swamp an average. */
export function toCp(s: Score): number {
  if (s.mate === null) return s.cp
  return s.mate > 0 ? MATE_CP - s.mate : -MATE_CP - s.mate
}

/** One UCI conversation, in whole lines.
 *
 *  Implementations own their own framing: `onLine` must be called once per
 *  complete engine line, already trimmed and never empty — except for the single
 *  empty line that signals the engine is gone. That sentinel is what stops a
 *  missing binary or a failed wasm load from hanging every pending search
 *  forever. */
export interface UciTransport {
  send(line: string): void
  onLine(cb: (line: string) => void): void
  close(): void | Promise<void>
}

export type EngineOptions = {
  /** Search depth. 12 is a sound floor for grading; 16+ is slower and rarely
   *  changes how a 4B model's move is classified. */
  depth?: number
  threads?: number
  hashMb?: number
}

export class Engine {
  private lines: string[] = []
  private waiters: ((line: string) => void)[] = []
  /** Tail of the queue of in-flight searches. See `analyse`. */
  private turnstile: Promise<unknown> = Promise.resolve()
  private dead = false
  readonly depth: number

  constructor(
    private transport: UciTransport,
    opts: EngineOptions = {},
  ) {
    this.depth = opts.depth ?? 12
    // UCI replies are strictly ordered, so a queue of one-shot waiters is enough.
    this.transport.onLine((line) => {
      if (!line) {
        // The engine is gone. Anyone still waiting would hang forever otherwise.
        this.dead = true
        for (const waiter of this.waiters.splice(0)) waiter('')
        return
      }
      const waiter = this.waiters.shift()
      if (waiter) waiter(line)
      else this.lines.push(line)
    })
    this.send(`setoption name Threads value ${opts.threads ?? 1}`)
    this.send(`setoption name Hash value ${opts.hashMb ?? 128}`)
  }

  private send(cmd: string): void {
    this.transport.send(cmd)
  }

  private nextLine(): Promise<string> {
    const buffered = this.lines.shift()
    if (buffered !== undefined) return Promise.resolve(buffered)
    if (this.dead) return Promise.resolve('')
    return new Promise((resolve) => this.waiters.push(resolve))
  }

  /** Reads until a line starts with `prefix`, collecting everything on the way.
   *  An empty line means the engine exited, which must not become an infinite
   *  loop — a missing binary would otherwise hang the whole run silently. */
  private async readUntil(prefix: string): Promise<string[]> {
    const collected: string[] = []
    for (;;) {
      const line = await this.nextLine()
      if (!line) throw new Error(`engine exited while waiting for "${prefix}"`)
      collected.push(line)
      if (line.startsWith(prefix)) return collected
    }
  }

  async ready(): Promise<void> {
    this.send('uci')
    await this.readUntil('uciok')
    this.send('isready')
    await this.readUntil('readyok')
  }

  /** Searches `fen` and returns the score from the side-to-move's point of view.
   *
   *  A position that is already over never gets searched: Stockfish reports
   *  `bestmove (none)` with no score, and reading that as 0.00 would grade a
   *  checkmate as a perfectly equal position. Callers handle terminal positions
   *  themselves, so this refuses rather than guesses. */
  /** Serialised against every other search on this engine.
   *
   *  One engine, one line-oriented channel, and a protocol with no request ids:
   *  two overlapping searches interleave their commands and then steal each
   *  other's `info`/`bestmove` lines off the same queue. That does not fail
   *  loudly — it quietly returns one search's score for the other's position,
   *  which in a grader means wrong centipawn numbers with no indication anything
   *  went wrong. Callers are free to run their *model* calls concurrently; the
   *  engine is the one part that must go one at a time. */
  analyse(fen: string, depth = this.depth, only?: string): Promise<Analysis> {
    const run = this.turnstile.then(() => this.search(fen, depth, only))
    // The queue must not break on a failed search, so the tail swallows errors;
    // the caller still receives the rejection through `run`.
    this.turnstile = run.catch(() => {})
    return run
  }

  private async search(fen: string, depth: number, only?: string): Promise<Analysis> {
    this.send('ucinewgame')
    this.send(`position fen ${fen}`)
    // `searchmoves` restricts the root to one move, which is what makes a played
    // move comparable to the best one: both are searched from the same node at
    // the same depth. Scoring the played move by analysing the position *after*
    // it would search one ply deeper and off by a tempo, biasing every result.
    this.send(`go depth ${depth}${only ? ` searchmoves ${only}` : ''}`)
    const out = await this.readUntil('bestmove')

    let score: Score | null = null
    let seenDepth = 0
    // The last `info` line carrying a score is the deepest completed iteration.
    for (const line of out) {
      if (!line.startsWith('info ')) continue
      const cp = line.match(/\bscore cp (-?\d+)/)
      const mate = line.match(/\bscore mate (-?\d+)/)
      const d = line.match(/\bdepth (\d+)/)
      if (!cp && !mate) continue
      if (d) seenDepth = Number(d[1])
      score = mate ? { cp: 0, mate: Number(mate[1]) } : { cp: Number(cp![1]), mate: null }
    }

    const best = out[out.length - 1].match(/^bestmove (\S+)/)?.[1] ?? null
    if (!score) throw new Error(`no score for fen "${fen}" (terminal position?)`)
    return { score, bestMove: best === '(none)' ? null : best, depth: seenDepth }
  }

  async close(): Promise<void> {
    try {
      this.send('quit')
    } catch {
      // Already gone; nothing to tell it.
    }
    await this.transport.close()
    this.dead = true
    for (const waiter of this.waiters.splice(0)) waiter('')
  }
}
