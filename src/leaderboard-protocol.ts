import { DEFAULT_PROMPT_TEMPLATE, type Settings } from './settings'

const runtimeHostname = typeof location === 'undefined' ? '' : location.hostname

export const LEADERBOARD_API =
  runtimeHostname === 'localhost' || runtimeHostname === '127.0.0.1'
    ? 'http://localhost:8787'
    : 'https://leaderboard.grandtensor.shantanugoel.com'

export const LEADERBOARD_APP_VERSION = '0.3.0'

/** A ranked bucket. Everything about a match is pinned except the models, so
 *  standings compare players rather than settings. The completion budget is the
 *  one axis allowed to differ, and it differs by circuit rather than freely:
 *  on OpenRouter the reasoning budget is a fixed fraction of `max_tokens`, so a
 *  bigger cap buys more thinking and measurably better play. Mixing caps in one
 *  table would rank budgets, not models. */
export type Circuit = {
  /** Stored per submission and used to partition standings. */
  id: string
  name: string
  maxTokens: number
  blurb: string
}

export const CIRCUITS: readonly Circuit[] = [
  {
    id: 'standard-v2',
    name: 'Standard Circuit',
    maxTokens: 16000,
    blurb: '16,000 tokens per move — enough for high reasoning effort to finish its thought.',
  },
  {
    id: 'extended-v1',
    name: 'Extended Circuit',
    maxTokens: 32000,
    blurb: '32,000 tokens per move — room for the deepest reasoning, at the highest cost.',
  },
]

export const DEFAULT_CIRCUIT = CIRCUITS[0]

/** Series length is the one pinned setting that only changes sample size: games
 *  are scored individually and the rating fit consumes them individually, so a
 *  6-game series is just three more data points than a 4-game one. Everything
 *  else that stays pinned changes what the model is asked to do.
 *
 *  It has to be even. Colors alternate from game one, so an odd series hands the
 *  player in slot 0 an extra game with White — and the rating fit has no color
 *  term to correct for it, because a submission reports only wins/draws/losses.
 *  Anyone who seats their favourite first and picks 3 games gets a real, silent
 *  edge while breaking no rule. */
export const RANKED_GAMES_MIN = 2
export const RANKED_GAMES_MAX = 10

export const isRankedGameCount = (games: number): boolean =>
  Number.isInteger(games) && games >= RANKED_GAMES_MIN && games <= RANKED_GAMES_MAX && games % 2 === 0

/** Ranked temperature. Unlike effort, this is continuous, so it cannot become
 *  part of the entrant key without splitting the board into unbounded buckets. */
export const RANKED_TEMPERATURE = 0.2

/** Re-prompts a player gets before forfeiting. Wider than it was, because the
 *  move parser stopped inventing moves out of prose: an off-shape reply now
 *  costs an attempt instead of quietly becoming a move. */
export const RANKED_RETRIES = 5

/** The circuit a match belongs to is derived from its cap, never sent alongside
 *  it — that keeps the client from nominating a bucket it didn't actually play. */
export const circuitFor = (maxTokens: number): Circuit | null =>
  CIRCUITS.find((circuit) => circuit.maxTokens === maxTokens) ?? null

export const circuitById = (id: string): Circuit | null =>
  CIRCUITS.find((circuit) => circuit.id === id) ?? null

export type ProtocolPlayer = {
  model: string
  effort: string
  temperature: number
}

export type ProtocolConfig = {
  baseUrl: string
  games: number
  maxPlies: number
  retries: number
  commentary: boolean
  includePreviousGames: boolean
  maxTokens: number
  promptHash: string
  players: [ProtocolPlayer, ProtocolPlayer]
}

export type SubmittedGame = {
  index: number
  white: 0 | 1
  result: '1-0' | '0-1' | '1/2-1/2'
  reason: 'checkmate' | 'stalemate' | 'insufficient_material' | 'threefold_repetition' | 'fifty_move_rule' | 'draw' | 'move_limit' | 'illegal_forfeit'
  plies: number
  pgn: string
}

export type LeaderboardSubmission = {
  schemaVersion: 1
  appVersion: string
  protocol: string
  installationId: string
  ticket: string
  turnstileToken: string
  config: ProtocolConfig
  games: SubmittedGame[]
}

/** An entrant is a model *at an effort level*, not a model. On OpenRouter the
 *  reasoning budget scales with effort, so one model at `low` and at `xhigh` are
 *  two different competitors; averaging them describes a configuration nobody
 *  ran. `default` (no effort parameter sent) is its own entrant — "whatever the
 *  provider picks" is a real, reproducible choice. */
export type Entrant = { model: string; effort: string }

/** Unambiguous because neither half can contain a space: model ids and efforts
 *  are both validated against regexes that exclude whitespace. */
export const entrantKey = (entrant: Entrant) => `${entrant.model} ${entrant.effort}`

export type Standing = {
  /** Null for provisional entrants, which are listed but not ranked. */
  rank: number | null
  model: string
  effort: string
  /** Bradley-Terry strength on an Elo-like scale, anchored so the field averages
   *  1500. Comparable only within a circuit. */
  rating: number
  /** Half-width of the 95% interval, in rating points. */
  ratingMargin: number
  /** Too few distinct opponents to rate credibly — shown, but unranked. */
  provisional: boolean
  /** Distinct opponents faced, which is what makes a rating meaningful. */
  opponents: number
  points: number
  games: number
  series: number
  wins: number
  draws: number
  losses: number
  scorePct: number
}

export type StandingsResponse = {
  protocol: string
  circuit: Circuit
  windowDays: number
  disclosure: string
  minOpponents: number
  standings: Standing[]
}

/** One opponent's worth of an entrant's record, for the drill-down view. */
export type HeadToHead = {
  model: string
  effort: string
  series: number
  games: number
  wins: number
  draws: number
  losses: number
  scorePct: number
}

export type EntrantSeries = {
  playedAt: number
  opponentModel: string
  opponentEffort: string
  games: number
  wins: number
  draws: number
  losses: number
}

export type EntrantResponse = {
  circuit: Circuit
  model: string
  effort: string
  games: number
  series: number
  wins: number
  draws: number
  losses: number
  scorePct: number
  headToHead: HeadToHead[]
  history: EntrantSeries[]
}

const encoder = new TextEncoder()

export async function sha256(value: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', encoder.encode(value))
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, '0')).join('')
}

/** Every settings field the ranked protocol has an opinion about. Named the same
 *  as the form controls so the settings modal can attach each verdict to the
 *  input that causes it. */
export type EligibilityField =
  | 'baseUrl'
  | 'games'
  | 'maxPlies'
  | 'retries'
  | 'commentary'
  | 'includePreviousGames'
  | 'maxTokens'
  | 'promptTemplate'
  | 'p0_model'
  | 'p1_model'
  | 'p0_temperature'
  | 'p1_temperature'

export type EligibilityIssue = { field: EligibilityField; reason: string }

export type Eligibility = {
  /** The circuit the completion cap selects, reported even when other fields
   *  block submission — "your cap says Extended, but the prompt is edited" is
   *  more useful than a bare refusal. */
  circuit: Circuit | null
  issues: EligibilityIssue[]
  eligible: boolean
}

const RANKED_CAPS = CIRCUITS.map((c) => c.maxTokens.toLocaleString('en-US')).join(' or ')

/** The single source of truth for what ranked play requires. Both the submit
 *  gate and the settings modal read it, so a rule can never drift between the
 *  explanation and the enforcement. */
export function inspectEligibility(settings: Settings): Eligibility {
  const issues: EligibilityIssue[] = []
  const circuit = circuitFor(settings.maxTokens)

  if (settings.baseUrl.replace(/\/+$/, '') !== 'https://openrouter.ai/api/v1')
    issues.push({ field: 'baseUrl', reason: 'Ranked play runs on OpenRouter, so every entrant faces the same providers.' })
  if (!isRankedGameCount(settings.games))
    issues.push({
      field: 'games',
      reason: `Ranked series run ${RANKED_GAMES_MIN}–${RANKED_GAMES_MAX} games, and an even number of them so both models get the same number of Whites.`,
    })
  if (settings.maxPlies !== 200)
    issues.push({ field: 'maxPlies', reason: 'Ranked games are adjudicated drawn at 200 plies, which sets the draw rate.' })
  if (settings.retries !== RANKED_RETRIES)
    issues.push({
      field: 'retries',
      reason: `Ranked matches allow ${RANKED_RETRIES} retries — more retries hide a model’s illegal moves, fewer punish a bad reply shape.`,
    })
  if (!settings.commentary)
    issues.push({ field: 'commentary', reason: 'Ranked matches ask for commentary, which changes what each model is prompted for.' })
  if (!settings.includePreviousGames)
    issues.push({ field: 'includePreviousGames', reason: 'Ranked matches show earlier games in the series.' })
  if (!circuit)
    issues.push({ field: 'maxTokens', reason: `Ranked matches run at ${RANKED_CAPS} max tokens per move.` })
  if (settings.promptTemplate !== DEFAULT_PROMPT_TEMPLATE)
    issues.push({ field: 'promptTemplate', reason: 'An edited prompt is an exhibition — it changes the task, not the player.' })

  settings.players.forEach((player, i) => {
    const model = `p${i}_model` as EligibilityField
    const temperature = `p${i}_temperature` as EligibilityField
    if (player.model.trim().toLowerCase() === 'random')
      issues.push({ field: model, reason: 'The local random mover is a demo opponent and cannot affect standings.' })
    if (player.temperature !== RANKED_TEMPERATURE)
      issues.push({ field: temperature, reason: `Ranked matches use temperature ${RANKED_TEMPERATURE} for both models.` })
  })
  if (settings.players[0].model.trim() === settings.players[1].model.trim())
    issues.push({ field: 'p1_model', reason: 'A model cannot play itself in a ranked match.' })

  return { circuit, issues, eligible: issues.length === 0 }
}

export async function protocolConfig(
  settings: Settings,
): Promise<{ config?: ProtocolConfig; circuit?: Circuit; reason?: string }> {
  const { circuit, issues, eligible } = inspectEligibility(settings)
  if (!eligible || !circuit) return { reason: issues[0]?.reason ?? 'This match is not eligible for ranked standings.' }

  return {
    circuit,
    config: {
      baseUrl: 'https://openrouter.ai/api/v1',
      games: settings.games,
      maxPlies: 200,
      retries: RANKED_RETRIES,
      commentary: true,
      includePreviousGames: true,
      maxTokens: circuit.maxTokens,
      promptHash: await sha256(DEFAULT_PROMPT_TEMPLATE),
      players: settings.players.map((player) => ({
        model: player.model.trim(),
        effort: player.effort,
        temperature: player.temperature,
      })) as [ProtocolPlayer, ProtocolPlayer],
    },
  }
}

export function submissionReason(reason: string): SubmittedGame['reason'] | null {
  if (reason === 'checkmate') return 'checkmate'
  if (reason === 'stalemate') return 'stalemate'
  if (reason === 'insufficient material') return 'insufficient_material'
  if (reason === 'threefold repetition') return 'threefold_repetition'
  if (reason === 'fifty-move rule') return 'fifty_move_rule'
  if (reason === 'draw') return 'draw'
  if (reason.startsWith('move limit (')) return 'move_limit'
  // Both forfeit causes are "the player never produced a move"; the protocol has
  // one code for that, so a token-cap forfeit submits as an illegal forfeit even
  // though the UI names it precisely.
  if (/ forfeits \((illegal moves|token cap)\)$/.test(reason)) return 'illegal_forfeit'
  return null
}
