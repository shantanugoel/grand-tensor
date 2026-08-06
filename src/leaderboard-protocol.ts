import { DEFAULT_PROMPT_TEMPLATE, type Settings } from './settings'

const runtimeHostname = typeof location === 'undefined' ? '' : location.hostname

export const LEADERBOARD_API =
  runtimeHostname === 'localhost' || runtimeHostname === '127.0.0.1'
    ? 'http://localhost:8787'
    : 'https://leaderboard.grandtensor.shantanugoel.com'

export const LEADERBOARD_APP_VERSION = '0.2.0'

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

export type Standing = {
  rank: number
  model: string
  points: number
  games: number
  series: number
  wins: number
  draws: number
  losses: number
  scorePct: number
}

const encoder = new TextEncoder()

export async function sha256(value: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', encoder.encode(value))
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, '0')).join('')
}

export async function protocolConfig(
  settings: Settings,
): Promise<{ config?: ProtocolConfig; circuit?: Circuit; reason?: string }> {
  if (settings.baseUrl.replace(/\/+$/, '') !== 'https://openrouter.ai/api/v1')
    return { reason: 'Only OpenRouter matches are eligible for ranked standings.' }
  if (settings.games !== 4) return { reason: 'Ranked matches use exactly 4 games.' }
  if (settings.maxPlies !== 200) return { reason: 'Ranked matches use a 200-ply limit.' }
  if (settings.retries !== 3) return { reason: 'Ranked matches allow 3 retries.' }
  if (!settings.commentary) return { reason: 'Ranked matches use commentary.' }
  if (!settings.includePreviousGames) return { reason: 'Ranked matches include previous games.' }

  const circuit = circuitFor(settings.maxTokens)
  if (!circuit)
    return {
      reason: `Ranked matches run at ${CIRCUITS.map((c) => c.maxTokens.toLocaleString('en-US')).join(' or ')} max tokens per move.`,
    }

  if (settings.promptTemplate !== DEFAULT_PROMPT_TEMPLATE)
    return { reason: 'Custom prompts are exhibitions and cannot affect standings.' }
  if (settings.players.some((player) => player.model.trim().toLowerCase() === 'random'))
    return { reason: 'Local random opponents are exhibitions and cannot affect standings.' }
  if (settings.players.some((player) => player.temperature !== 0.2))
    return { reason: 'Ranked matches use temperature 0.2 for both models.' }
  if (settings.players[0].model === settings.players[1].model)
    return { reason: 'A model cannot play itself in a ranked match.' }

  return {
    circuit,
    config: {
      baseUrl: 'https://openrouter.ai/api/v1',
      games: 4,
      maxPlies: 200,
      retries: 3,
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
