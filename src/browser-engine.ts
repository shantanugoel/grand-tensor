/** Real Stockfish in the browser, for commentary.
 *
 *  The same UCI layer the offline eval harness drives over stdio (`src/eval/`),
 *  pointed at a single-threaded wasm build in a Web Worker. It is the only thing
 *  that grades a move here: the client-side evaluator this replaced could not
 *  read a sacrifice, a recapture or a mating net, and had to be told to keep
 *  quiet about all three.
 *
 *  Three things this deliberately is not:
 *
 *  - Loaded eagerly. It is 7 MB of wasm against a page that is mostly a 3D
 *    scene, so nothing fetches it until the first move wants grading.
 *  - On the critical path. Grading a move takes far longer than the board
 *    animation, so callers hand the verdict in late rather than wait for it.
 *    A move it cannot reach keeps its line in the log with no label — no
 *    verdict beats a worse one from a shallower source.
 *  - Anywhere near the result. Ranked play is material-only by design: the
 *    Worker recomputes the result, the adjudication and the standings from the
 *    PGN, and it has no engine to check a client's claim against. Everything
 *    here is commentary, the eval bar and the accuracy stat. */

import { Engine } from './eval/engine'
import { gradeMove, type MoveGrade } from './eval/cpl'
import { WorkerTransport } from './eval/worker-transport'
import { ENGINE_URL } from './engine-assets'

/** Measured in the browser rather than inherited from the harness, which runs a
 *  native binary and settled on 12.
 *
 *  The wasm build turned out to have far more headroom than the harness figure
 *  suggested, because the search runs in a Worker and competes with nothing: on
 *  a laptop, one search over six representative positions came out at 70ms mean
 *  and 156ms worst at this depth, against 21ms/42ms at depth 12 and 373ms/658ms
 *  at 18. A grade is two searches, so this is roughly a third of a second in the
 *  worst case here and perhaps a second and a half on a slow phone — against
 *  turns that take minutes, and off the main thread either way.
 *
 *  Two steps past the harness rather than four: past 14 the cost roughly doubles
 *  per two ply while the classification barely moves, and battery on a phone is
 *  a real cost for a label nobody is reading a second time. */
export const GRADE_DEPTH = 14

/** How long a single grade gets before it is abandoned.
 *
 *  A search that never returns would otherwise wedge the queue behind it and
 *  quietly stop every later verdict, which looks exactly like the feature not
 *  working. Generous against a measured worst case, because a slow verdict
 *  still arrives and a timed-out one never does. */
const GRADE_TIMEOUT_MS = 20_000

/** Downloading and compiling 7 MB of wasm, on whatever connection the page
 *  arrived over. */
const BOOT_TIMEOUT_MS = 60_000

export type { MoveGrade }

let engine: Promise<Engine | null> | null = null

/** Boots the engine once, and remembers a failure as a failure: a browser that
 *  cannot compile the wasm will not manage it on the ninetieth move either, and
 *  retrying would refetch 7 MB per ply. */
function boot(): Promise<Engine | null> {
  if (engine) return engine
  engine = (async () => {
    try {
      const worker = new Worker(ENGINE_URL)
      const started = new Engine(new WorkerTransport(worker), { depth: GRADE_DEPTH, threads: 1, hashMb: 16 })
      // A handshake that never completes is the one failure mode that does not
      // announce itself — no error event, just silence — and every later verdict
      // would queue behind it forever. 7 MB over a slow connection is the reason
      // the budget is this generous.
      const up = await Promise.race([
        started.ready().then(() => true),
        new Promise<false>((resolve) => setTimeout(() => resolve(false), BOOT_TIMEOUT_MS)),
      ])
      if (!up) {
        void started.close()
        return null
      }
      return started
    } catch {
      return null
    }
  })()
  return engine
}

/** Whether the engine is up, without booting it. Lets the UI say which
 *  evaluation a number came from instead of quietly mixing the two. */
export function engineReady(): boolean {
  return loaded
}
let loaded = false

/** Starts the download. Idempotent, and safe to call from a click handler — the
 *  point is to get the fetch going before the first verdict is wanted. */
export function warmEngine(): void {
  void boot().then((e) => {
    loaded = e !== null
  })
}

/** Grades one move, or returns null if the engine is unavailable or too slow.
 *
 *  Null means "no opinion", not "error": the move is still played, logged and
 *  scored — it simply goes uncalled. */
export async function gradeInBrowser(fen: string, san: string): Promise<MoveGrade | null> {
  const e = await boot()
  if (!e) return null
  loaded = true
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    return await Promise.race([
      gradeMove(e, fen, san, GRADE_DEPTH),
      new Promise<null>((resolve) => {
        timer = setTimeout(() => resolve(null), GRADE_TIMEOUT_MS)
      }),
    ])
  } catch {
    // An illegal move, a terminal position, or a worker that died mid-search.
    // None of them are worth a broken match over.
    return null
  } finally {
    clearTimeout(timer)
  }
}
