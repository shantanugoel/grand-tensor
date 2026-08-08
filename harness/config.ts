/** Harness definitions: what to run, how to talk to it, what its reply looks like.
 *
 *  Seven agents ship baked in. A user config file — TOML or JSON — is merged over
 *  them by `id`, so overriding one field of `pi` does not mean restating the
 *  whole block, and an eighth harness is a new block rather than a code change. */

export type ExtractMode = 'text' | 'json' | 'jsonl-last'

/** Where the reply and its usage live in whatever the process printed.
 *
 *  `text` takes stdout verbatim. `json` parses stdout as one object. `jsonl-last`
 *  parses stdout as JSON Lines and keeps the last line whose `type` equals
 *  `select` — the shape every event-streaming agent here emits. */
export type Extract = {
  mode: ExtractMode
  select?: string
  /** Narrows `select` further, as dotted path → required value. Needed wherever
   *  an event type covers more than the reply — pi emits `message_end` for the
   *  prompt it was handed as well as for the answer. */
  where?: Record<string, string>
  /** Dotted path to the reply text. Ignored by `text` mode, which is all reply. */
  text?: string
  /** One path, or several to be summed — a provider that reports cached prompt
   *  tokens in their own fields needs all of them to give a true total. */
  input?: string | string[]
  output?: string | string[]
  reasoning?: string | string[]
  cost?: string | string[]
  /** Dotted path to the harness's own explanation of a failure, reported in
   *  place of a slice of stdout when there is no reply. */
  error?: string
}

/** A per-model exception to the harness-wide lists. Rare enough that the common
 *  case stays a plain array of ids. */
export type ModelOverride = { efforts?: string[] }

export type HarnessDef = {
  id: string
  command: string
  args: string[]
  /** Rendered and written to the process's stdin. Omitted means stdin is closed. */
  stdin?: string
  /** Working directory, relative to the config file. Agents read AGENTS.md and
   *  CLAUDE.md from wherever they start, so pointing every harness at a scratch
   *  directory is what stops a chess move inheriting a repo's instructions. */
  cwd?: string
  env?: Record<string, string>
  timeoutMs: number
  /** Used when the model field names the harness and nothing else. */
  defaultModel?: string
  /** Advisory, never a whitelist — see `resolveModel`. Feeds the datalist only. */
  models: string[]
  /** Asked for the list instead of hard-coding it. Result is cached. */
  modelsCommand?: string[]
  modelsParse: 'lines' | 'json' | 'regex'
  /** For `json`: dotted path to the array. Items may be strings or carry `.id`. */
  modelsPath?: string
  /** For `regex`: a per-line pattern, and how to rebuild an id from its groups. */
  modelsPattern?: string
  modelsReplace?: string
  modelsSkip?: number
  modelOverrides: Record<string, ModelOverride>
  /** Reasoning levels this harness accepts, advertised per model on /models. */
  efforts: string[]
  /** What this CLI calls disabled reasoning. Null means it cannot be disabled. */
  effortOff: string | null
  /** Renames, for a CLI whose spelling differs from the dropdown's. */
  effortMap: Record<string, string>
  /** The agent writes its final message to a file rather than stdout, and the
   *  args reference it as {{outfile}}. Usage still comes from stdout. */
  outfile: boolean
  extract: Extract
  enabled: boolean
}

const def = (partial: Partial<HarnessDef> & Pick<HarnessDef, 'id' | 'command' | 'args'>): HarnessDef => ({
  timeoutMs: 300_000,
  models: [],
  modelsParse: 'lines',
  modelOverrides: {},
  efforts: [],
  effortOff: null,
  effortMap: {},
  outfile: false,
  extract: { mode: 'text' },
  enabled: true,
  cwd: 'sandbox',
  ...partial,
})

/** Model ids are hints for the datalist, not a gate. A harness that renames or
 *  adds a model keeps working without anyone touching this file; the only cost
 *  of a stale entry here is a stale autocomplete suggestion. */
export const BUILTINS: HarnessDef[] = [
  def({
    id: 'claude-code',
    command: 'claude',
    // --system-prompt replaces Claude Code's own, which is most of what makes it
    // behave like a coding agent rather than a model. --strict-mcp-config keeps
    // the user's MCP servers out of a chess move.
    args: [
      '-p',
      '--output-format', 'json',
      '--strict-mcp-config',
      '--model', '{{model}}',
      '--system-prompt', '{{system}}',
      '--effort', '{{effort}}',
    ],
    stdin: '{{user}}',
    defaultModel: 'sonnet',
    models: ['opus', 'sonnet', 'haiku'],
    // Claude Code takes an effort level like the reasoning models it drives. It
    // has no "off", so the dropdown offers levels and the provider default only.
    efforts: ['low', 'medium', 'high', 'xhigh', 'max'],
    extract: {
      mode: 'json',
      text: 'result',
      // Cached prompt tokens are reported in their own fields, and `input_tokens`
      // alone counts only what missed the cache — 10 against a real ~12,000.
      input: ['usage.input_tokens', 'usage.cache_creation_input_tokens', 'usage.cache_read_input_tokens'],
      output: 'usage.output_tokens',
      cost: 'total_cost_usd',
    },
  }),

  def({
    id: 'codex',
    command: 'codex',
    // `-` reads the prompt from stdin. The final message goes to a file because
    // the --json event schema moves between versions and a file does not.
    args: [
      'exec',
      '--skip-git-repo-check',
      '--ignore-user-config',
      '-s', 'read-only',
      '-m', '{{model}}',
      '-o', '{{outfile}}',
      '-',
    ],
    stdin: '{{messages}}',
    outfile: true,
    models: ['gpt-5.6-codex', 'gpt-5.6'],
  }),

  def({
    id: 'gemini',
    command: 'gemini',
    // The prompt rides in argv rather than stdin: -p appends to stdin instead of
    // replacing it, so passing both would send the prompt twice. A move prompt is
    // a few KB against a 1 MB argv limit.
    args: [
      '-p', '{{messages}}',
      '-o', 'json',
      '-m', '{{model}}',
      '--approval-mode', 'plan',
    ],
    models: ['gemini-3-pro', 'gemini-3-flash'],
    extract: { mode: 'json', text: 'response' },
  }),

  def({
    id: 'amp',
    command: 'amp',
    // -m is amp's agent mode, not a model id — mode is the axis it exposes, so
    // that is what the model field selects. Plain -x prints the last assistant
    // message and nothing else; --stream-json would carry usage, but its schema
    // is not pinned and a wrong guess costs the reply, not just the counters.
    args: ['-x', '--no-notifications', '--no-color', '--no-ide', '-m', '{{model}}'],
    stdin: '{{messages}}',
    defaultModel: 'smart',
    models: ['smart', 'deep', 'large', 'rush', 'free'],
  }),

  def({
    id: 'pi',
    command: 'pi',
    args: [
      '-p',
      '--mode', 'json',
      '--no-tools',
      '--no-session',
      '--no-context-files',
      '--no-extensions',
      '--model', '{{model}}',
      '--system-prompt', '{{system}}',
      '--thinking', '{{effort}}',
    ],
    stdin: '{{user}}',
    // `provider  model  context  …` columns; pi wants the first two joined.
    modelsCommand: ['pi', '--list-models'],
    modelsParse: 'regex',
    modelsPattern: '^(\\S+)\\s+(\\S+)',
    modelsReplace: '$1/$2',
    modelsSkip: 1,
    efforts: ['minimal', 'low', 'medium', 'high', 'xhigh'],
    effortOff: 'off',
    extract: {
      mode: 'jsonl-last',
      select: 'message_end',
      where: { 'message.role': 'assistant' },
      text: 'message.content',
      input: 'message.usage.input',
      output: 'message.usage.output',
      cost: 'message.usage.cost.total',
      error: 'message.errorMessage',
    },
  }),

  def({
    id: 'prime-agent',
    command: 'prime-agent',
    args: [
      '-p',
      '--mode', 'json',
      '--no-tools',
      '--no-session',
      '--offline',
      '--model', '{{model}}',
      '--system-prompt', '{{system}}',
      '--thinking', '{{effort}}',
    ],
    stdin: '{{user}}',
    // Shares pi's lineage and its listing format. Not installed here, so the
    // pattern is inherited rather than verified — check it against the real
    // output before trusting the autocomplete.
    modelsCommand: ['prime-agent', 'model', 'list'],
    modelsParse: 'regex',
    modelsPattern: '^(\\S+)\\s+(\\S+)',
    modelsReplace: '$1/$2',
    modelsSkip: 1,
    efforts: ['minimal', 'low', 'medium', 'high', 'xhigh', 'max'],
    effortOff: 'off',
    extract: {
      mode: 'jsonl-last',
      select: 'message_end',
      where: { 'message.role': 'assistant' },
      text: 'message.content',
      input: 'message.usage.input',
      output: 'message.usage.output',
      cost: 'message.usage.cost.total',
      error: 'message.errorMessage',
    },
  }),

  def({
    id: 'hermes',
    command: 'hermes',
    // No JSON output and no system-prompt flag, so: raw stdout, and the system
    // message is prepended to the prompt like the other flagless agents.
    args: [
      'chat',
      '-q', '{{messages}}',
      '-m', '{{model}}',
      '-Q',
      '--ignore-user-config',
      '--ignore-rules',
    ],
  }),
]

/** Reasoning effort as it arrives on the wire, mapped to what a CLI wants.
 *
 *  The app sends no `reasoning_effort` field for "default" and the literal
 *  `none` for "off" (see src/llm.ts). Null here means "drop the flag", which is
 *  the only honest rendering of "let the harness decide". */
export function resolveEffort(harness: HarnessDef, effort: string | undefined): string | null {
  if (!effort) return null
  if (effort === 'none' || effort === 'off') return harness.effortOff
  return harness.effortMap[effort] ?? effort
}

/** Splits `pi/anthropic/claude-opus-5` into its harness and everything after.
 *
 *  On the first slash only, because a model id is itself frequently
 *  `provider/model`. An unlisted model still resolves: `models` decides what is
 *  suggested, never what is allowed, so a harness that gains a model overnight
 *  works without this file being touched. */
export function resolveModel(
  harnesses: Map<string, HarnessDef>,
  requested: string,
): { harness: HarnessDef; model: string } | null {
  const id = requested.trim()
  const cut = id.indexOf('/')
  const head = cut === -1 ? id : id.slice(0, cut)
  const harness = harnesses.get(head)
  if (!harness || !harness.enabled) return null
  const rest = cut === -1 ? '' : id.slice(cut + 1)
  return { harness, model: rest || harness.defaultModel || '' }
}

/** Accepts TOML's snake_case and the internal camelCase alike, so a config can
 *  be written either way without the reader having to know which. */
function normalizeKeys(raw: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(raw)) {
    out[key.replace(/_([a-z])/g, (_, c: string) => c.toUpperCase())] = value
  }
  return out
}

export function mergeHarnesses(base: HarnessDef[], overrides: unknown): HarnessDef[] {
  if (!Array.isArray(overrides)) return base
  const merged = new Map(base.map((h) => [h.id, h]))
  for (const raw of overrides) {
    if (!raw || typeof raw !== 'object') continue
    const patch = normalizeKeys(raw as Record<string, unknown>) as Partial<HarnessDef>
    if (typeof patch.id !== 'string' || !patch.id) continue
    const existing = merged.get(patch.id)
    if (existing) {
      // `extract` is merged one level down, so overriding a single path — say the
      // cost field — does not silently drop the text path with it.
      const extract = patch.extract
        ? ({ ...existing.extract, ...normalizeKeys(patch.extract as Record<string, unknown>) } as Extract)
        : existing.extract
      merged.set(patch.id, { ...existing, ...patch, extract })
    } else {
      if (typeof patch.command !== 'string' || !Array.isArray(patch.args)) continue
      merged.set(patch.id, def(patch as Partial<HarnessDef> & Pick<HarnessDef, 'id' | 'command' | 'args'>))
    }
  }
  return [...merged.values()]
}

/** Reads a user config, if there is one. TOML and JSON are both accepted; the
 *  file's own extension decides, and a missing file is not an error — the
 *  built-ins are a complete configuration on their own. */
export async function loadConfig(path?: string): Promise<{ harnesses: HarnessDef[]; source: string | null }> {
  if (!path) return { harnesses: BUILTINS, source: null }
  const file = Bun.file(path)
  if (!(await file.exists())) return { harnesses: BUILTINS, source: null }

  const raw = await file.text()
  const parsed = path.endsWith('.json') ? JSON.parse(raw) : Bun.TOML.parse(raw)
  const list = (parsed as any)?.harness ?? (parsed as any)?.harnesses
  return { harnesses: mergeHarnesses(BUILTINS, list), source: path }
}
