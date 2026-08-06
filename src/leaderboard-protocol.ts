import { DEFAULT_PROMPT_TEMPLATE, type Settings } from './settings'

const runtimeHostname = typeof location === 'undefined' ? '' : location.hostname

export const LEADERBOARD_API =
  runtimeHostname === 'localhost' || runtimeHostname === '127.0.0.1'
    ? 'http://localhost:8787'
    : 'https://leaderboard.grandtensor.shantanugoel.com'

export const LEADERBOARD_PROTOCOL = 'standard-v1'
export const LEADERBOARD_APP_VERSION = '0.1.0'

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

export async function protocolConfig(settings: Settings): Promise<{ config?: ProtocolConfig; reason?: string }> {
  if (settings.baseUrl.replace(/\/+$/, '') !== 'https://openrouter.ai/api/v1')
    return { reason: 'Only OpenRouter matches are eligible for Standard Circuit standings.' }
  if (settings.games !== 4) return { reason: 'Standard Circuit matches use exactly 4 games.' }
  if (settings.maxPlies !== 200) return { reason: 'Standard Circuit matches use a 200-ply limit.' }
  if (settings.retries !== 3) return { reason: 'Standard Circuit matches allow 3 retries.' }
  if (!settings.commentary) return { reason: 'Standard Circuit matches use commentary.' }
  if (!settings.includePreviousGames) return { reason: 'Standard Circuit matches include previous games.' }
  if (settings.maxTokens !== 8000) return { reason: 'Standard Circuit matches use 8,000 max tokens per move.' }
  if (settings.promptTemplate !== DEFAULT_PROMPT_TEMPLATE)
    return { reason: 'Custom prompts are exhibitions and cannot affect standings.' }
  if (settings.players.some((player) => player.model.trim().toLowerCase() === 'random'))
    return { reason: 'Local random opponents are exhibitions and cannot affect standings.' }
  if (settings.players.some((player) => player.temperature !== 0.2))
    return { reason: 'Standard Circuit matches use temperature 0.2 for both models.' }
  if (settings.players[0].model === settings.players[1].model)
    return { reason: 'A model cannot play itself in a ranked match.' }

  return {
    config: {
      baseUrl: 'https://openrouter.ai/api/v1',
      games: 4,
      maxPlies: 200,
      retries: 3,
      commentary: true,
      includePreviousGames: true,
      maxTokens: 8000,
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
  if (reason.endsWith('forfeits (illegal moves)')) return 'illegal_forfeit'
  return null
}
