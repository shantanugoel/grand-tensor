/** Rendering a chat request into a command line, running it, and reading it back. */

import { mkdir, readFile, rm } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { tmpdir } from 'node:os'
import { extract, type Extracted } from './extract'
import { resolveEffort, type HarnessDef } from './config'

export type ChatMessage = { role: string; content: string }

export type RunRequest = {
  harness: HarnessDef
  model: string
  messages: ChatMessage[]
  effort?: string
  temperature?: number
  maxTokens?: number
  signal?: AbortSignal
  /** Everything relative in a harness definition resolves against this. */
  root: string
}

export type RunResult = Extracted & { ms: number; finish: 'stop' | 'length' }

export class HarnessError extends Error {
  constructor(message: string, readonly status = 502) {
    super(message)
    this.name = 'HarnessError'
  }
}

/** The system message, and everything else flattened into one prompt.
 *
 *  Four of the seven agents have no system-prompt flag, so for those the system
 *  message is prepended to the prompt instead — the same text, one channel down.
 *  Retry turns arrive here too: when a move comes back illegal the app appends
 *  the rejected reply and a correction, and flattening keeps that exchange
 *  intact for a CLI that only accepts a single string. */
export function flatten(messages: ChatMessage[]): { system: string; user: string; all: string } {
  const system = messages
    .filter((m) => m.role === 'system')
    .map((m) => m.content)
    .join('\n\n')

  const rest = messages.filter((m) => m.role !== 'system')
  const user =
    rest.length === 1
      ? rest[0].content
      : rest.map((m) => `[${m.role}]\n${m.content}`).join('\n\n')

  return { system, user, all: system ? `${system}\n\n${user}` : user }
}

/** Substitutes {{name}} from `vars`. Null means the value does not apply, which
 *  is a different thing from empty — see `renderArgs`. */
function render(template: string, vars: Record<string, string | null>): string | null {
  let dropped = false
  const out = template.replace(/\{\{(\w+)\}\}/g, (whole, name: string) => {
    if (!(name in vars)) return whole
    const value = vars[name]
    if (value === null || value === '') {
      dropped = true
      return ''
    }
    return value
  })
  return dropped ? null : out
}

/** An argument whose placeholder does not apply is dropped, and so is the flag
 *  in front of it — `--thinking {{effort}}` has to vanish as a pair when the
 *  player chose the provider default, because `--thinking ""` is an error and
 *  `--thinking default` is a level no CLI has. */
export function renderArgs(args: string[], vars: Record<string, string | null>): string[] {
  const out: string[] = []
  for (const arg of args) {
    const rendered = render(arg, vars)
    if (rendered === null) {
      if (out.length && out[out.length - 1].startsWith('-')) out.pop()
      continue
    }
    out.push(rendered)
  }
  return out
}

export async function run(req: RunRequest): Promise<RunResult> {
  const { harness } = req
  const { system, user, all } = flatten(req.messages)

  // Written into the harness's own scratch directory rather than the system
  // temp dir, so a sandboxed agent can still read what it just wrote.
  const cwd = harness.cwd ? resolve(req.root, harness.cwd) : req.root
  await mkdir(cwd, { recursive: true })

  const outfile = harness.outfile ? join(tmpdir(), `grand-tensor-${crypto.randomUUID()}.txt`) : null

  const vars: Record<string, string | null> = {
    system,
    user,
    messages: all,
    model: req.model || null,
    effort: resolveEffort(harness, req.effort),
    temperature: req.temperature == null ? null : String(req.temperature),
    maxTokens: req.maxTokens == null ? null : String(req.maxTokens),
    outfile,
  }

  const args = renderArgs(harness.args, vars)
  const stdin = harness.stdin ? render(harness.stdin, vars) : null

  const started = performance.now()
  let proc: ReturnType<typeof Bun.spawn>
  try {
    proc = Bun.spawn([harness.command, ...args], {
      cwd,
      stdin: stdin == null ? 'ignore' : new TextEncoder().encode(stdin),
      stdout: 'pipe',
      stderr: 'pipe',
      env: { ...process.env, ...harness.env },
    })
  } catch (err) {
    // Almost always a binary that isn't installed or isn't on PATH. Say which
    // one, because "spawn ENOENT" in a browser console explains nothing.
    await rm(outfile ?? '', { force: true }).catch(() => {})
    // 400, not 5xx: a binary that isn't installed will not become installed by
    // being asked again, and the app rides out 5xx forever by default.
    throw new HarnessError(`Could not start "${harness.command}" for ${harness.id}: ${message(err)}`, 400)
  }

  // A killed process is the only way out of an agent that has decided to think
  // for an hour, and the only way a stopped series stops paying for one.
  let timedOut = false
  const timer = setTimeout(() => ((timedOut = true), proc.kill()), harness.timeoutMs)
  const onAbort = () => proc.kill()
  req.signal?.addEventListener('abort', onAbort, { once: true })

  try {
    // Cast because the conditional `stdin` above widens Bun's spawn typing to a
    // union that covers file descriptors; both are pipes here by construction.
    const [stdout, stderr, code] = await Promise.all([
      new Response(proc.stdout as ReadableStream<Uint8Array>).text(),
      new Response(proc.stderr as ReadableStream<Uint8Array>).text(),
      proc.exited,
    ])

    if (req.signal?.aborted) throw new HarnessError('Request aborted', 499)
    if (timedOut)
      throw new HarnessError(`${harness.id} timed out after ${Math.round(harness.timeoutMs / 1000)}s`, 504)

    const written = outfile ? await readFile(outfile, 'utf8').catch(() => '') : undefined

    // A non-zero exit with usable text still counts: several of these agents
    // exit non-zero on a warning they printed after the answer. Nothing to show
    // is what actually makes it a failure.
    const result = extract(harness.extract, stdout, written)
    if (!result.text.trim()) {
      // The harness's own account of the failure first: "400 The requested model
      // is not supported" names the actual problem, where a slice of the event
      // stream makes a wrong model id look like a broken shim.
      const detail = (result.error.trim() || stderr.trim() || stdout.trim() || '(no output)').slice(0, 400)
      throw new HarnessError(`${harness.id} exited ${code} with no reply: ${detail}`)
    }

    return { ...result, ms: performance.now() - started, finish: 'stop' }
  } finally {
    clearTimeout(timer)
    req.signal?.removeEventListener('abort', onAbort)
    if (outfile) await rm(outfile, { force: true }).catch(() => {})
  }
}

export const message = (err: unknown) => (err instanceof Error ? err.message : String(err))
