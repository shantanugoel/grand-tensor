/** All user-tunable configuration. Persisted in localStorage, edited in the UI. */

/** Reasoning effort. The valid set is per-model and comes from the endpoint's
 *  /models listing, so this is a plain string rather than a fixed union —
 *  `deepseek-v4-flash` takes max/high/low with no medium, `gpt-5.6-luna` adds
 *  xhigh and none, and older models take nothing at all. */
export type Effort = string

/** Send no effort parameter and let the provider pick. */
export const NO_EFFORT = 'default'

/** Turn reasoning off outright, for models whose metadata says it is optional.
 *
 *  Not the same as a low effort, and on some models it is the only thing that
 *  works: deepseek-v4-flash ignores `low`, ignores a reasoning token budget, and
 *  ignores the flat `reasoning_effort` field — all three land within 2.5% of the
 *  same ~12,700 reasoning tokens and then return an empty reply. Off is the one
 *  setting it honours, and it answers in three seconds instead of twelve minutes. */
export const REASONING_OFF = 'off'

/** Canonicalise the provider's name for disabled reasoning to the app's. */
export const normalizeReasoningEffort = (effort: Effort): Effort =>
  effort === 'none' ? REASONING_OFF : effort

export type PlayerConfig = {
  /** Display name shown in the HUD. */
  label: string
  /** Model id as the API expects it, e.g. "deepseek/deepseek-v4-flash-0731". */
  model: string
  effort: Effort
  temperature: number
}

/** User-message template sent for every move. The system prompt remains fixed so
 *  models still return the JSON shape the move parser expects. */
export const DEFAULT_PROMPT_TEMPLATE = [
  `You are {{player}}, playing a game of chess as {{color}} against {{opponent}}.`,
  `This is game {{gameNumber}} of {{totalGames}}.`,
  ``,
  `FEN: {{fen}}`,
  ``,
  `{{board}}`,
  ``,
  `Move number: {{moveNumber}}`,
  `Last move: {{lastMove}}`,
  `Check status: {{inCheck}}`,
  ``,
  `Moves so far: {{moves}}`,
  ``,
  `Previous games in this series:`,
  `{{previousGames}}`,
  ``,
  `{{threats}}`,
  ``,
  `LEGAL MOVES ({{legalMoveCount}}), with origin square and what attacks the square you land on:`,
  `{{annotatedMoves}}`,
  ``,
  `Choose your move.`,
].join('\n')

/** Turn-speed presets: pause between moves, and how leisurely pieces animate. */
export const SPEEDS = [
  // Even Turbo keeps enough frames for the piece to visibly cross the board.
  // Its speed comes from removing the pause between moves, not teleporting them.
  { label: 'Turbo', delay: 0, anim: 0.55 },
  { label: 'Blitz', delay: 0, anim: 0.7 },
  { label: 'Fast', delay: 200, anim: 0.85 },
  { label: 'Normal', delay: 600, anim: 1 },
  { label: 'Slow', delay: 1300, anim: 1.3 },
  { label: 'Very slow', delay: 2400, anim: 1.7 },
  { label: 'Cinematic', delay: 4000, anim: 2.2 },
]

/** All-local demo matches can otherwise complete an entire Turbo series in one
 *  browser task, starving the renderer until only the result is visible. */
export function effectiveSpeedIndex(s: Pick<Settings, 'players' | 'speed'>): number {
  const isLocalDemo = s.players.every((player) => player.model.trim().toLowerCase() === 'random')
  return isLocalDemo && s.speed === 0 ? 1 : s.speed
}

export type Settings = {
  baseUrl: string
  apiKey: string
  /** Index 0 plays white in game 1, then colors alternate. */
  players: [PlayerConfig, PlayerConfig]
  games: number
  /** Half-moves before a game is adjudicated on material. */
  maxPlies: number
  /** Re-prompts allowed after an illegal/unparseable move before forfeiting. */
  retries: number
  /** Connection failures to ride out before the series parks itself and waits
   *  for a human. 0 means keep trying — which is what an unattended run wants,
   *  since a stall nobody is there to clear is just a slower halt. */
  networkRetries: number
  /** Index into SPEEDS. */
  speed: number
  /** Ask each model for a one-line rationale alongside its move. */
  commentary: boolean
  /** User-message template rendered for each model turn. */
  promptTemplate: string
  /** Give models completed games from this series, including moves/results. */
  includePreviousGames: boolean
  maxTokens: number
}

export const DEFAULTS: Settings = {
  baseUrl: 'https://openrouter.ai/api/v1',
  apiKey: '',
  players: [
    { label: 'DeepSeek V4 Flash', model: 'deepseek/deepseek-v4-flash-0731', effort: 'default', temperature: 0.2 },
    { label: 'GPT-5.6 Luna', model: 'openai/gpt-5.6-luna', effort: 'default', temperature: 0.2 },
  ],
  games: 2,
  maxPlies: 200,
  // The move parser no longer scrapes a move out of free prose, so a reply that
  // misses the JSON shape now costs an attempt instead of being silently turned
  // into a move the model never nominated. That is the honest accounting, and it
  // needs a wider budget to stay a measurement of chess rather than of syntax.
  retries: 5,
  networkRetries: 0,
  speed: 0,
  commentary: true,
  promptTemplate: DEFAULT_PROMPT_TEMPLATE,
  includePreviousGames: true,
  // A ceiling, not a target: billing is per token used, so a model that wants
  // 2,300 costs the same here as it did at 16,000. What changes is that nothing
  // gets cut off mid-thought — at 16,000, deepseek-v4-flash returned no move at
  // all on 80% of positions, and gpt-5.6-luna on 30% of them at high effort.
  //
  // The exposure this creates is real but chosen: it is reasoning effort, not
  // this number, that decides how much a model actually spends.
  maxTokens: 128000,
}

/** Versioned, so a schema change discards stale settings instead of needing an
 *  upgrade path for each field. Three of those paths used to live here and could
 *  not tell a saved stock value from a deliberately chosen identical one — a
 *  returning player who genuinely wanted 3 retries got moved anyway.
 *
 *  Bumped to :3 because `promptTemplate` and `maxTokens` are both persisted. A
 *  returning player would otherwise have kept the pre-scaffolding prompt — worth
 *  46.7 cp per move — and a 16,000 cap that no longer belongs to any circuit, so
 *  every match they ran would have been quietly unrankable. */
const KEY = 'grand-tensor:settings:3'

export function loadSettings(): Settings {
  try {
    const raw = localStorage.getItem(KEY)
    if (!raw) return structuredClone(DEFAULTS)
    const saved = JSON.parse(raw) as Partial<Settings>
    const players = (saved.players ?? DEFAULTS.players).map((p, i) => {
      const player = { ...DEFAULTS.players[i], ...p }
      return { ...player, effort: normalizeReasoningEffort(player.effort) }
    }) as [PlayerConfig, PlayerConfig]
    return {
      ...structuredClone(DEFAULTS),
      ...saved,
      players,
    }
  } catch {
    return structuredClone(DEFAULTS)
  }
}

export const isFirstVisit = () => localStorage.getItem(KEY) === null

export function saveSettings(s: Settings) {
  localStorage.setItem(KEY, JSON.stringify(s))
}
