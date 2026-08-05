/** All user-tunable configuration. Persisted in localStorage, edited in the UI. */

export type Effort = 'default' | 'minimal' | 'low' | 'medium' | 'high'

export type PlayerConfig = {
  /** Display name shown in the HUD. */
  label: string
  /** Model id as the API expects it, e.g. "deepseek/deepseek-v4-flash-0731". */
  model: string
  effort: Effort
  temperature: number
}

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
  speed: 3,
  commentary: true,
  // Generous by default: reasoning models spend most of this before they answer.
  maxTokens: 4000,
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
    return { ...structuredClone(DEFAULTS), ...saved, players }
  } catch {
    return structuredClone(DEFAULTS)
  }
}

export const isFirstVisit = () => localStorage.getItem(KEY) === null

export function saveSettings(s: Settings) {
  localStorage.setItem(KEY, JSON.stringify(s))
}
