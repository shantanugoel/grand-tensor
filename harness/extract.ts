/** Pulling a reply and its token counts out of whatever an agent CLI printed.
 *
 *  Three shapes cover all seven: raw stdout, one JSON object, or JSON Lines with
 *  the answer on the last event of a given type. Everything below is deliberately
 *  forgiving — a missing usage path costs a counter, never the move. */

import type { Extract } from './config'

export type Extracted = {
  text: string
  input: number
  output: number
  reasoning: number
  cost: number
  /** What the harness said went wrong, when it said anything. Only consulted
   *  when there is no reply, and worth far more than a slice of stdout: pi
   *  reports "400 The requested model is not supported" in a field, and dumping
   *  raw events instead makes a wrong model id look like a broken shim. */
  error: string
}

/** `a.b.c` through plain objects. Arrays are indexable by number, which is all
 *  the traversal any of these schemas needs. */
export function pick(source: unknown, path: string | undefined): unknown {
  if (!path) return undefined
  let cursor: any = source
  for (const key of path.split('.')) {
    if (cursor == null) return undefined
    cursor = cursor[key]
  }
  return cursor
}

/** Coerces whatever sat at the text path into a string.
 *
 *  Agents disagree about the shape of an assistant message: a bare string, or
 *  the content-block array that every tool-using model now returns. Blocks that
 *  aren't text — thinking, tool calls — are dropped rather than stringified,
 *  because a reasoning trace is the model's working and not its answer. */
export function pickText(source: unknown, path: string | undefined): string {
  const value = pick(source, path)
  if (typeof value === 'string') return value
  if (Array.isArray(value)) {
    return value
      .map((item) => (typeof item === 'string' ? item : item?.type === 'text' ? String(item.text ?? '') : ''))
      .join('')
  }
  if (value && typeof value === 'object' && typeof (value as any).text === 'string') return (value as any).text
  return ''
}

/** A usage figure, from one path or the sum of several.
 *
 *  Several is not a luxury: Claude Code reports `input_tokens` alongside
 *  `cache_creation_input_tokens` and `cache_read_input_tokens`, and the first of
 *  those alone was 10 where the prompt was really about 12,000. Reading one path
 *  understated the count by three orders of magnitude. */
const num = (source: unknown, path: string | string[] | undefined): number => {
  if (Array.isArray(path)) return path.reduce((total, one) => total + num(source, one), 0)
  const value = pick(source, path)
  return typeof value === 'number' && Number.isFinite(value) ? value : 0
}

/** Every well-formed JSON line, in order. A partial or noisy line is skipped:
 *  agents write progress to stdout too, and one stray line must not lose the
 *  reply that follows it. */
export function jsonLines(stdout: string): unknown[] {
  const out: unknown[] = []
  for (const line of stdout.split('\n')) {
    const trimmed = line.trim()
    if (!trimmed.startsWith('{')) continue
    try {
      out.push(JSON.parse(trimmed))
    } catch {
      // Interleaved or truncated output — not this line's turn to matter.
    }
  }
  return out
}

/** The first balanced `{…}` in the text, string-aware. Agents prepend banners
 *  and append timings around the JSON they were asked for; a greedy match from
 *  the first brace to the last would swallow both. */
function firstJsonObject(text: string): string | null {
  for (let start = text.indexOf('{'); start !== -1; start = text.indexOf('{', start + 1)) {
    let depth = 0
    let inString = false
    let escaped = false
    for (let i = start; i < text.length; i++) {
      const ch = text[i]
      if (inString) {
        if (escaped) escaped = false
        else if (ch === '\\') escaped = true
        else if (ch === '"') inString = false
        continue
      }
      if (ch === '"') inString = true
      else if (ch === '{') depth++
      else if (ch === '}' && --depth === 0) return text.slice(start, i + 1)
    }
  }
  return null
}

/** Every `where` path holds its expected value. Used to tell an event apart from
 *  one that merely shares its type — pi emits `message_end` for the prompt it
 *  was given as well as for the answer, and only one of those is a reply. */
const matches = (event: unknown, where: Record<string, string> | undefined) =>
  !where || Object.entries(where).every(([path, want]) => String(pick(event, path) ?? '') === want)

export function extract(spec: Extract, stdout: string, override?: string): Extracted {
  const empty: Extracted = { text: '', input: 0, output: 0, reasoning: 0, cost: 0, error: '' }

  if (spec.mode === 'text') return { ...empty, text: override ?? stdout }

  let root: unknown = null
  if (spec.mode === 'json') {
    const object = firstJsonObject(stdout)
    if (object) {
      try {
        root = JSON.parse(object)
      } catch {
        root = null
      }
    }
  } else {
    const events = jsonLines(stdout)
    const matching = events.filter((e) => (!spec.select || (e as any)?.type === spec.select) && matches(e, spec.where))
    root = matching[matching.length - 1] ?? null
  }

  // An outfile always wins: it is the agent's own final answer, written on
  // purpose, where stdout is a stream we are guessing our way through.
  const text = override ?? pickText(root, spec.text)
  return {
    text,
    input: num(root, spec.input),
    output: num(root, spec.output),
    reasoning: num(root, spec.reasoning),
    cost: num(root, spec.cost),
    error: pickText(root, spec.error),
  }
}
