/** The eval CLI: grade models and prompt variants on a fixed position set.
 *
 *  Usage:
 *    bun run src/eval/run.ts --models "a,b" --variants baseline,scaffolded
 *
 *  Reads GRAND_TENSOR_API_KEY (or OPENROUTER_API_KEY) and GRAND_TENSOR_BASE_URL
 *  from the environment — Bun loads .env automatically. */

import { Chess } from 'chess.js'
import { chat, ChatError, type ChatRequest, type ChatResult, fetchModels, type ModelInfo } from '../llm'
import { parseMove, type LegalMove } from '../prompt'
import { Engine, engineAvailable } from './engine'
import { Grader } from './cpl'
import { generate, load, save, type Position, type PositionSet } from './positions'
import { comparePaired, summarize, type Summary } from './stats'
import { byName, type Variant } from './variants'

type Args = Record<string, string | boolean>

function parseArgs(argv: string[]): Args {
  const out: Args = {}
  for (let i = 0; i < argv.length; i++) {
    if (!argv[i].startsWith('--')) continue
    const key = argv[i].slice(2)
    const next = argv[i + 1]
    if (next && !next.startsWith('--')) (out[key] = next), i++
    else out[key] = true
  }
  return out
}

type Attempt = {
  model: string
  variant: string
  position: Position
  san: string | null
  /** Why no move, when there is none. `error` is ours (network, engine), not the
   *  model's — folding it into `illegal` would blame a model for our own faults. */
  failure: 'illegal' | 'truncated' | 'error' | null
  cpl: number | null
  best: string | null
  promptTokens: number
  completionTokens: number
  /** Part of `completionTokens`, and the number that explains a truncation. */
  reasoningTokens: number
  cost: number
  ms: number
}

/** Runs `jobs` with at most `limit` in flight. API calls dominate wall time and
 *  are almost entirely waiting, so this is where the run gets its speed. */
async function pooled<T>(
  jobs: (() => Promise<T>)[],
  limit: number,
  onProgress?: (done: number, total: number) => void,
): Promise<T[]> {
  const results = new Array<T>(jobs.length)
  let cursor = 0
  let done = 0
  const workers = Array.from({ length: Math.min(limit, jobs.length) }, async () => {
    for (;;) {
      const i = cursor++
      if (i >= jobs.length) return
      results[i] = await jobs[i]()
      onProgress?.(++done, jobs.length)
    }
  })
  await Promise.all(workers)
  return results
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

/** One completion, riding out transient provider failures.
 *
 *  The arena already does this in `chatWithRecovery`; the benchmark did not, and
 *  a rate-limited provider turned into missing rows rather than a slower run.
 *  That is worse than it sounds: the positions that 429 are whichever ones were
 *  in flight when the limit hit, so the holes are not random and the surviving
 *  sample is quietly biased.
 *
 *  Backoff is jittered because the whole point is that several workers hit the
 *  limit at once — retrying them in lockstep just rebuilds the burst that caused
 *  it. A non-retryable failure (bad key, unknown model) is raised immediately;
 *  no amount of waiting fixes those. */
export async function retrying<T>(
  send: () => Promise<T>,
  attempts = 5,
  wait: (ms: number) => Promise<unknown> = sleep,
): Promise<T> {
  for (let attempt = 0; ; attempt++) {
    try {
      return await send()
    } catch (err) {
      if (attempt >= attempts || !(err instanceof ChatError) || !err.retryable) throw err
      const backoff = Math.min(30_000, 1000 * 2 ** attempt)
      await wait(backoff * (0.5 + Math.random()))
    }
  }
}

/** A request that never returns is indistinguishable from a slow one, and this
 *  benchmark waits on models that legitimately think for half an hour — so the
 *  deadline is generous and configurable rather than absent. A stall is treated
 *  as retryable: it is a connection that died quietly, which is exactly the case
 *  another attempt fixes. */
const chatWithRetry = (req: ChatRequest, timeoutMs: number): Promise<ChatResult> =>
  retrying(async () => {
    try {
      // Fresh per attempt — a signal already timed out would abort the retry
      // before it was sent.
      return await chat({ ...req, signal: AbortSignal.timeout(timeoutMs) })
    } catch (err) {
      if (err instanceof Error && (err.name === 'TimeoutError' || err.name === 'AbortError'))
        throw new ChatError(`no response within ${Math.round(timeoutMs / 1000)}s`, true)
      throw err
    }
  })

const pct = (x: number) => `${(x * 100).toFixed(1)}%`
const cp = (x: number) => x.toFixed(1)

function printSummary(
  label: string,
  s: Summary,
  failures: { illegal: number; truncated: number; error: number },
) {
  console.log(
    `  ${label.padEnd(38)} n=${String(s.n).padStart(4)}  ` +
      `mean=${cp(s.meanCpl).padStart(7)}  median=${cp(s.medianCpl).padStart(6)}  ` +
      `p90=${cp(s.p90Cpl).padStart(7)}  blunder=${pct(s.blunderRate).padStart(6)}  ` +
      `best=${pct(s.bestRate).padStart(6)}  illegal=${failures.illegal}  trunc=${failures.truncated}` +
      (failures.error ? `  harness-errors=${failures.error}` : ''),
  )
}

async function main() {
  const args = parseArgs(Bun.argv.slice(2))

  const baseUrl = String(args.baseUrl ?? process.env.GRAND_TENSOR_BASE_URL ?? 'https://openrouter.ai/api/v1')
  const apiKey = String(args.apiKey ?? process.env.GRAND_TENSOR_API_KEY ?? process.env.OPENROUTER_API_KEY ?? '')
  const enginePath = String(args.engine ?? 'stockfish')

  if (!(await engineAvailable(enginePath))) {
    console.error(`No engine at "${enginePath}". Install one with:  brew install stockfish`)
    process.exit(1)
  }
  if (!apiKey) {
    console.error('No API key. Set GRAND_TENSOR_API_KEY in .env, or pass --apiKey.')
    process.exit(1)
  }

  const depth = Number(args.depth ?? 12)
  const maxTokens = Number(args.maxTokens ?? 16000)
  const temperature = Number(args.temperature ?? 0)
  const concurrency = Number(args.concurrency ?? 4)
  const setPath = String(args.positions ?? 'eval/positions.json')

  // Left unset, each provider applies its own default — which differs by model
  // (medium for gpt-5.6-luna, high for deepseek-v4-flash). Comparing two models
  // that way silently compares two different amounts of thinking, so a benchmark
  // wanting a like-for-like answer has to pin this.
  const effort = String(args.effort ?? 'default')
  // Generous by default: a single move at max effort was measured at 37 minutes,
  // so a tight deadline would discard real answers rather than catch stalls.
  const timeoutMs = Number(args.timeout ?? 900) * 1000

  const models = String(args.models ?? '')
    .split(',')
    .map((m) => m.trim())
    .filter(Boolean)
  if (!models.length) {
    console.error('Pass --models "openai/gpt-5.6-luna,qwen/qwen-3.5-4b"')
    process.exit(1)
  }

  const variants: Variant[] = String(args.variants ?? 'baseline')
    .split(',')
    .map((v) => byName(v.trim()))

  const engine = new Engine({ path: enginePath, depth, threads: Number(args.threads ?? 2) })
  await engine.ready()

  // Build or reuse the position set. Reuse is the default because comparing two
  // runs only means anything when they were graded on the same positions.
  let set: PositionSet
  if (await Bun.file(setPath).exists()) {
    set = await load(setPath)
    console.log(`Positions: ${set.positions.length} from ${setPath}`)
  } else {
    console.log('Generating position set (one time)...')
    set = await generate(engine, { seed: Number(args.seed ?? 1), games: Number(args.games ?? 12), engine })
    await save(setPath, set)
    console.log(`Positions: ${set.positions.length} written to ${setPath}`)
  }

  // Offset matters for short probes: the set is ordered by game and then by ply,
  // so the first entries are all openings — the phase where models reason least
  // and blunder least. Sizing a token budget from those would underestimate it.
  const offset = Number(args.offset ?? 0)
  const limit = Number(args.limit ?? set.positions.length)
  const positions = set.positions.slice(offset, offset + limit)

  const grader = new Grader(engine, depth)
  console.log(`Priming engine at depth ${depth} over ${positions.length} positions...`)
  const engineStart = performance.now()
  await grader.prime(positions.map((p) => p.fen))
  console.log(`Engine baseline ready in ${((performance.now() - engineStart) / 1000).toFixed(1)}s\n`)

  let modelInfo = new Map<string, ModelInfo>()
  try {
    modelInfo = await fetchModels(baseUrl, apiKey)
  } catch {
    // Pricing is a nicety; the run does not depend on it.
  }

  /** Written as each move is graded rather than once at the end.
   *
   *  A run that was killed at 159 of 160 moves left nothing behind, because the
   *  results only existed in memory until the last one landed — and the runs
   *  worth interrupting are exactly the long ones whose data is most expensive
   *  to recreate. One JSON object per line, so a partial file is still a valid
   *  file: `jq -s` reads it back as an array, and a truncated final line costs
   *  one row rather than the lot. */
  const sink = args.json ? Bun.file(String(args.json)).writer() : null

  // Kept alongside pooled()'s return value, which only materialises at the end.
  // The interrupt handler reports from this.
  const done: Attempt[] = []
  const record = (attempt: Attempt): Attempt => {
    done.push(attempt)
    if (sink) {
      // One write per line and an immediate flush: the point is surviving a kill,
      // which a buffer defeats.
      sink.write(JSON.stringify(attempt) + '\n')
      sink.flush()
    }
    return attempt
  }

  const jobs: (() => Promise<Attempt>)[] = []
  for (const model of models) {
    for (const variant of variants) {
      for (const position of positions) {
        jobs.push(async () => {
          const chess = new Chess(position.fen)
          const legal: LegalMove[] = chess.moves({ verbose: true }).map((m) => ({ san: m.san, lan: m.lan }))
          const color = chess.turn() === 'w' ? 'white' : 'black'
          const base: Attempt = {
            model,
            variant: variant.name,
            position,
            san: null,
            failure: null,
            cpl: null,
            best: null,
            promptTokens: 0,
            completionTokens: 0,
            reasoningTokens: 0,
            cost: 0,
            ms: 0,
          }
          try {
            const result = await chatWithRetry(
              {
                baseUrl,
                apiKey,
                model,
                temperature,
                maxTokens,
                effort,
                pricing: modelInfo.get(model)?.pricing,
                messages: variant.build({
                  position,
                  legal,
                  color,
                  maxTokens,
                  player: model,
                  opponent: 'opponent',
                }),
              },
              timeoutMs,
            )
            base.promptTokens = result.usage.prompt
            base.completionTokens = result.usage.completion
            base.reasoningTokens = result.usage.reasoning
            base.cost = result.usage.cost
            base.ms = result.ms

            const parsed = parseMove(result.text, legal)
            if (!parsed.san) {
              // Same distinction the arena draws: a reply that ran out of budget
              // never made a move, and blaming that on chess would be wrong.
              base.failure = result.finish === 'length' || !result.text.trim() ? 'truncated' : 'illegal'
              return record(base)
            }
            // One attempt per position, no retries. Retries are a property of the
            // arena, not of move quality, and allowing them here would let a model
            // launder a bad first answer into a good score.
            const grade = await grader.grade(position.fen, parsed.san)
            base.san = parsed.san
            base.cpl = grade.cpl
            base.best = grade.best
            return record(base)
          } catch (err) {
            base.failure = 'error'
            console.error(`  ${model}/${variant.name}/${position.id}: ${err instanceof Error ? err.message : err}`)
            return record(base)
          }
        })
      }
    }
  }

  // Ctrl-C on a long run used to throw away every move already graded. The rows
  // are on disk by now either way; this is so the summary is too, without having
  // to go and re-read the file.
  let interrupted = false
  process.on('SIGINT', () => {
    if (interrupted) process.exit(130) // A second Ctrl-C means they mean it.
    interrupted = true
    console.log(`\n\nInterrupted after ${done.length} of ${jobs.length} moves. Reporting what finished:\n`)
    report(done)
    sink?.end()
    process.exit(130)
  })

  console.log(`Running ${jobs.length} graded moves (${models.length} models x ${variants.length} variants x ${positions.length} positions)...`)
  const runStart = performance.now()
  // Reasoning models take a minute or more per move, so a run of any size is
  // otherwise silent for a long time and indistinguishable from a hang. Progress
  // goes to stderr to keep stdout clean for anything parsing the report.
  let lastReport = 0
  const attempts = await pooled(jobs, concurrency, (completed, total) => {
    const now = performance.now()
    if (completed !== total && now - lastReport < 15_000) return
    lastReport = now
    const elapsed = (now - runStart) / 1000
    const eta = (elapsed / completed) * (total - completed)
    console.error(
      `  ${completed}/${total} moves  ${elapsed.toFixed(0)}s elapsed` +
        (completed === total ? '' : `  ~${eta.toFixed(0)}s left`),
    )
  })
  console.log(`Done in ${((performance.now() - runStart) / 1000).toFixed(1)}s\n`)
  report(attempts)
  sink?.end()
  if (args.json) console.log(`\nPer-move detail in ${args.json}`)
  await engine.close()

  /** Printed from whatever has finished, so an interrupted run still says what
   *  it learned. Closes over the run's configuration rather than taking it as
   *  arguments, because the signal handler has no way to pass any. */
  function report(rows: Attempt[]) {
    console.log('=== RESULTS ===')
    const cplByKey = new Map<string, Map<string, number>>()
    for (const model of models) {
      console.log(`\n${model}`)
      for (const variant of variants) {
        const forArm = rows.filter((a) => a.model === model && a.variant === variant.name)
        const scored = forArm.filter((a) => a.cpl !== null)
        cplByKey.set(`${model}|${variant.name}`, new Map(scored.map((a) => [a.position.id, a.cpl!])))
        printSummary(variant.name, summarize(scored.map((a) => a.cpl!)), {
          illegal: forArm.filter((a) => a.failure === 'illegal').length,
          truncated: forArm.filter((a) => a.failure === 'truncated').length,
          error: forArm.filter((a) => a.failure === 'error').length,
        })
      }

      // Paired comparisons against the first variant listed.
      if (variants.length > 1) {
        const control = cplByKey.get(`${model}|${variants[0].name}`)!
        for (const variant of variants.slice(1)) {
          const c = comparePaired(control, cplByKey.get(`${model}|${variant.name}`)!)
          const verdict = c.significant ? (c.meanDiff > 0 ? 'BETTER' : 'WORSE') : 'no significant difference'
          console.log(
            `    ${variants[0].name} -> ${variant.name}: ${cp(c.meanDiff)} cp ` +
              `(95% CI ${cp(c.ci95[0])} to ${cp(c.ci95[1])}, paired n=${c.n}) — ${verdict}`,
          )
        }
      }

      const spend = rows.filter((a) => a.model === model)
      const cost = spend.reduce((t, a) => t + a.cost, 0)
      const completion = spend.reduce((t, a) => t + a.completionTokens, 0)
      const reasoning = spend.reduce((t, a) => t + a.reasoningTokens, 0)
      const answered = spend.filter((a) => a.completionTokens > 0)
      const perCall = answered.length ? Math.round(reasoning / answered.length) : 0
      console.log(
        `    effort=${effort}  avg reasoning/call: ${perCall} of ${maxTokens} budget` +
          `  (${completion} completion total)   cost: $${cost.toFixed(4)}`,
      )
    }
  }
}

// Only when run as a command. Without this, importing anything from here — the
// tests import `retrying` — starts a benchmark and then exits the process for
// want of a --models flag.
if (import.meta.main) {
  main().catch((err) => {
    console.error(err)
    process.exit(1)
  })
}
