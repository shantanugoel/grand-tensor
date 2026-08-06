/** All user-tunable configuration. Persisted in localStorage, edited in the UI. */

/** Reasoning effort. The valid set is per-model and comes from the endpoint's
 *  /models listing, so this is a plain string rather than a fixed union —
 *  `deepseek-v4-flash` takes max/high/low with no medium, `gpt-5.6-luna` adds
 *  xhigh and none, and older models take nothing at all. */
export type Effort = string

/** Send no effort parameter and let the provider pick. */
export const NO_EFFORT = 'default'

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
  `Move number: {{moveNumber}}`,
  `Last move: {{lastMove}}`,
  `Check status: {{inCheck}}`,
  ``,
  `Moves so far: {{moves}}`,
  ``,
  `Previous games in this series:`,
  `{{previousGames}}`,
  ``,
  `LEGAL MOVES ({{legalMoveCount}}): {{legalMoves}}`,
  ``,
  `Choose your move.`,
].join('\n')

/** The original built-in template was persisted like a customization. Upgrade
 *  that exact stock value while preserving every genuinely edited prompt. */
const LEGACY_DEFAULT_PROMPT_TEMPLATES = [
  [
    `You are {{player}}, playing {{color}} against {{opponent}}.`,
    `This is game {{gameNumber}} of {{totalGames}}.`,
    ``,
    `FEN: {{fen}}`,
    `Move number: {{moveNumber}}`,
    `Last move: {{lastMove}}`,
    `Check status: {{inCheck}}`,
    ``,
    `Moves so far: {{moves}}`,
    ``,
    `Previous games in this series:`,
    `{{previousGames}}`,
    ``,
    `LEGAL MOVES ({{legalMoveCount}}): {{legalMoves}}`,
    ``,
    `Choose your move.`,
  ].join('\n'),
]

export const currentPromptTemplate = (saved?: string): string =>
  saved === undefined || LEGACY_DEFAULT_PROMPT_TEMPLATES.includes(saved) ? DEFAULT_PROMPT_TEMPLATE : saved

/** Turn-speed presets: pause between moves, and how leisurely pieces animate. */
export const SPEEDS = [
  { label: 'Turbo', delay: 0, anim: 0 },
  { label: 'Blitz', delay: 0, anim: 0.35 },
  { label: 'Fast', delay: 200, anim: 0.6 },
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
  /** Half-moves before a game is adjudicated as a draw. */
  maxPlies: number
  /** Re-prompts allowed after an illegal/unparseable move before forfeiting. */
  retries: number
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
  games: 4,
  maxPlies: 200,
  retries: 3,
  speed: 0,
  commentary: true,
  promptTemplate: DEFAULT_PROMPT_TEMPLATE,
  includePreviousGames: true,
  // Generous by default: reasoning models spend most of this before they answer.
  maxTokens: 8000,
}

const KEY = 'grand-tensor:settings'

export function loadSettings(): Settings {
  try {
    const raw = localStorage.getItem(KEY)
    if (!raw) return structuredClone(DEFAULTS)
    const saved = JSON.parse(raw) as Partial<Settings>
    const players = (saved.players ?? DEFAULTS.players).map((p, i) => ({
      ...DEFAULTS.players[i],
      ...p,
    })) as [PlayerConfig, PlayerConfig]
    return {
      ...structuredClone(DEFAULTS),
      ...saved,
      players,
      promptTemplate: currentPromptTemplate(saved.promptTemplate),
    }
  } catch {
    return structuredClone(DEFAULTS)
  }
}

export const isFirstVisit = () => localStorage.getItem(KEY) === null

export function saveSettings(s: Settings) {
  localStorage.setItem(KEY, JSON.stringify(s))
}
