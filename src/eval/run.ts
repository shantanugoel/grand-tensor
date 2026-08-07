/** The eval CLI: grade models and prompt variants on a fixed position set.
 *
 *  Usage:
 *    bun run src/eval/run.ts --models "a,b" --variants baseline,scaffolded
 *
 *  Reads GRAND_TENSOR_API_KEY (or OPENROUTER_API_KEY) and GRAND_TENSOR_BASE_URL
 *  from the environment — Bun loads .env automatically. */

import { Chess } from 'chess.js'
import { chat, fetchModels, type ModelInfo } from '../llm'
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
async function pooled<T>(jobs: (() => Promise<T>)[], limit: number): Promise<T[]> {
  const results = new Array<T>(jobs.length)
  let cursor = 0
  const workers = Array.from({ length: Math.min(limit, jobs.length) }, async () => {
    for (;;) {
      const i = cursor++
      if (i >= jobs.length) return
      results[i] = await jobs[i]()
    }
  })
  await Promise.all(workers)
  return results
}

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

  const limit = Number(args.limit ?? set.positions.length)
  const positions = set.positions.slice(0, limit)

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
            const result = await chat({
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
            })
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
              return base
            }
            // One attempt per position, no retries. Retries are a property of the
            // arena, not of move quality, and allowing them here would let a model
            // launder a bad first answer into a good score.
            const grade = await grader.grade(position.fen, parsed.san)
            base.san = parsed.san
            base.cpl = grade.cpl
            base.best = grade.best
            return base
          } catch (err) {
            base.failure = 'error'
            console.error(`  ${model}/${variant.name}/${position.id}: ${err instanceof Error ? err.message : err}`)
            return base
          }
        })
      }
    }
  }

  console.log(`Running ${jobs.length} graded moves (${models.length} models x ${variants.length} variants x ${positions.length} positions)...`)
  const runStart = performance.now()
  const attempts = await pooled(jobs, concurrency)
  console.log(`Done in ${((performance.now() - runStart) / 1000).toFixed(1)}s\n`)

  console.log('=== RESULTS ===')
  const cplByKey = new Map<string, Map<string, number>>()
  for (const model of models) {
    console.log(`\n${model}`)
    for (const variant of variants) {
      const rows = attempts.filter((a) => a.model === model && a.variant === variant.name)
      const scored = rows.filter((a) => a.cpl !== null)
      const byPosition = new Map(scored.map((a) => [a.position.id, a.cpl!]))
      cplByKey.set(`${model}|${variant.name}`, byPosition)
      printSummary(variant.name, summarize(scored.map((a) => a.cpl!)), {
        illegal: rows.filter((a) => a.failure === 'illegal').length,
        truncated: rows.filter((a) => a.failure === 'truncated').length,
        error: rows.filter((a) => a.failure === 'error').length,
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

    const spend = attempts.filter((a) => a.model === model)
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

  if (args.json) {
    await Bun.write(String(args.json), JSON.stringify(attempts, null, 2))
    console.log(`\nPer-move detail written to ${args.json}`)
  }

  await engine.close()
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
