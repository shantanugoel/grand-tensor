/** The model catalog behind GET /models.
 *
 *  Two things matter here. A harness that can list its own models is asked
 *  rather than hard-coded, so the list never goes stale by hand. And the answer
 *  is cached, because the app hits /models both when the settings modal opens
 *  and again at the top of every series — spawning an agent process on each of
 *  those would make opening a dialog cost a subprocess. */

import type { HarnessDef } from './config'

export type ModelRow = {
  id: string
  object: 'model'
  owned_by: string
  reasoning: { supported_efforts: string[]; mandatory: boolean } | null
}

const ANSI = /\x1b\[[0-9;]*m/g
/** Deliberately narrow: a model id is one word of id-ish characters. Anything
 *  with a space in it is a heading or a sentence, and both show up in the output
 *  of a CLI that never expected to be parsed. */
const ID = /^[\w][\w.:@/+-]*$/
/** A capital letter is the tell for prose — "Available", "Run", "Usage". Model
 *  ids that do carry one are always punctuated too (`Qwen/Qwen3`), so the pair
 *  of tests separates a heading from an id without a vocabulary list. */
const PROSE = /[A-Z]/
const IDISH = /[\d/.:@_-]/

export function looksLikeId(token: string): boolean {
  if (!token || token.length > 120 || token.endsWith(':')) return false
  if (!ID.test(token)) return false
  return !PROSE.test(token) || IDISH.test(token)
}

/** First token of each line, kept only if it looks like an id.
 *
 *  A heuristic, and named as one: `models_parse = "lines"` is a convenience for
 *  CLIs with no machine-readable listing, and an explicit `models` array in the
 *  config always beats it. */
export function parseLines(stdout: string): string[] {
  const out = new Set<string>()
  for (const line of stdout.replace(ANSI, '').split('\n')) {
    const token = line.trim().split(/\s+/)[0]
    if (looksLikeId(token)) out.add(token)
  }
  return [...out]
}

/** For a listing whose id is spread across columns.
 *
 *  `pi --list-models` prints provider and model in separate columns, and the id
 *  it wants back is the two joined by a slash — so no amount of first-token
 *  guessing gets there. A capture-and-rebuild pattern does, and it generalises
 *  to any table a CLI happens to print. Lines that do not match are skipped,
 *  which is also how the header is discarded when `skip` misses it. */
export function parseRegex(stdout: string, pattern: string, replace: string, skip = 0): string[] {
  let re: RegExp
  try {
    re = new RegExp(pattern)
  } catch {
    return []
  }
  const out = new Set<string>()
  for (const line of stdout.replace(ANSI, '').split('\n').slice(skip)) {
    const match = re.exec(line.trim())
    if (!match) continue
    const id = replace.replace(/\$(\d)/g, (_, index: string) => match[Number(index)] ?? '')
    if (looksLikeId(id)) out.add(id)
  }
  return [...out]
}

export function parseJson(stdout: string, path?: string): string[] {
  let root: unknown
  try {
    root = JSON.parse(stdout)
  } catch {
    return []
  }
  let cursor: any = root
  for (const key of (path ?? '').split('.').filter(Boolean)) {
    if (cursor == null) return []
    cursor = cursor[key]
  }
  if (!Array.isArray(cursor)) return []
  return cursor
    .map((item) => (typeof item === 'string' ? item : typeof item?.id === 'string' ? item.id : ''))
    .filter(Boolean)
}

type Entry = { at: number; models: string[] }

export class Catalog {
  private cache = new Map<string, Entry>()
  /** Refreshes in flight, so two callers arriving together spawn one process. */
  private pending = new Map<string, Promise<string[]>>()

  constructor(private harnesses: HarnessDef[], private ttlMs = 300_000) {}

  /** Discovery is best-effort in both directions: a failed listing falls back to
   *  the configured array, and a successful one is unioned with it rather than
   *  replacing it, so a hand-added id survives a CLI that doesn't mention it. */
  async models(harness: HarnessDef): Promise<string[]> {
    if (!harness.modelsCommand?.length) return harness.models

    const now = Date.now()
    const hit = this.cache.get(harness.id)
    if (hit && now - hit.at < this.ttlMs) return hit.models

    const inFlight = this.pending.get(harness.id)
    if (inFlight) return inFlight

    const job = this.discover(harness)
      .then((found) => {
        const models = [...new Set([...harness.models, ...found])]
        // Nothing came back — keep whatever the last good answer was rather than
        // emptying a working datalist because the CLI was mid-update.
        const entry = models.length ? models : (hit?.models ?? harness.models)
        this.cache.set(harness.id, { at: Date.now(), models: entry })
        return entry
      })
      .catch(() => hit?.models ?? harness.models)
      .finally(() => this.pending.delete(harness.id))

    this.pending.set(harness.id, job)
    return job
  }

  private async discover(harness: HarnessDef): Promise<string[]> {
    const [command, ...args] = harness.modelsCommand!
    const proc = Bun.spawn([command, ...args], {
      stdin: 'ignore',
      stdout: 'pipe',
      stderr: 'pipe',
      env: { ...process.env, ...harness.env },
    })
    // Short on purpose: this runs while a settings dialog is open, and a listing
    // that needs longer than this is not worth making the user wait for.
    const timer = setTimeout(() => proc.kill(), 10_000)
    try {
      // Both streams, concatenated. A listing is human-facing output, and plenty
      // of CLIs send it to stderr — `pi --list-models` does — so reading only
      // stdout finds nothing and silently reports a harness with no models.
      const [out, err] = await Promise.all([
        new Response(proc.stdout).text(),
        new Response(proc.stderr).text(),
      ])
      const stdout = out + err
      await proc.exited
      if (harness.modelsParse === 'json') return parseJson(stdout, harness.modelsPath)
      if (harness.modelsParse === 'regex')
        return parseRegex(stdout, harness.modelsPattern ?? '', harness.modelsReplace ?? '$1', harness.modelsSkip)
      return parseLines(stdout)
    } finally {
      clearTimeout(timer)
    }
  }

  /** One row per harness × model, plus a bare harness id wherever a default
   *  model makes that a complete choice on its own.
   *
   *  Every row carries its harness's effort levels, which is what makes the
   *  app's per-model effort dropdown work: it reads exactly this field. */
  async list(): Promise<ModelRow[]> {
    const rows: ModelRow[] = []
    for (const harness of this.harnesses) {
      if (!harness.enabled) continue
      const reasoning = (model: string) => {
        const efforts = harness.modelOverrides[model]?.efforts ?? harness.efforts
        return efforts.length ? { supported_efforts: efforts, mandatory: harness.effortOff === null } : null
      }
      if (harness.defaultModel)
        rows.push({ id: harness.id, object: 'model', owned_by: harness.id, reasoning: reasoning(harness.defaultModel) })
      for (const model of await this.models(harness))
        rows.push({
          id: `${harness.id}/${model}`,
          object: 'model',
          owned_by: harness.id,
          reasoning: reasoning(model),
        })
    }
    return rows
  }
}
