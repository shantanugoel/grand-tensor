import { Chess } from 'chess.js'
import {
  circuitFor,
  isRankedGameCount,
  LEADERBOARD_APP_VERSION,
  RANKED_GAMES_MAX,
  RANKED_GAMES_MIN,
  RANKED_RETRIES,
  RANKED_TEMPERATURE,
  type Circuit,
  type ProtocolConfig,
  type SubmittedGame,
} from '../src/leaderboard-protocol'
import { DEFAULT_PROMPT_TEMPLATE } from '../src/settings'

const MODEL_RE = /^[a-z0-9][a-z0-9._-]{0,63}\/[a-z0-9][a-z0-9._:/-]{0,127}$/i
const EFFORT_RE = /^[a-z][a-z0-9_-]{1,15}$/i
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
const encoder = new TextEncoder()

export type ValidatedSubmission = {
  appVersion: string
  protocol: string
  installationId: string
  ticket: string
  turnstileToken: string
  config: ProtocolConfig
  circuit: Circuit
  games: SubmittedGame[]
  scoreAX2: number
  scoreBX2: number
  winsA: number
  drawsA: number
  lossesA: number
  canonical: string
}

export async function sha256(value: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', encoder.encode(value))
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, '0')).join('')
}

function object(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null
}

function exactKeys(value: Record<string, unknown>, keys: string[]) {
  const actual = Object.keys(value).sort()
  return actual.length === keys.length && actual.every((key, index) => key === [...keys].sort()[index])
}

export async function expectedPromptHash() {
  return sha256(DEFAULT_PROMPT_TEMPLATE)
}

/** Validates a config and reports which circuit its completion cap places it in.
 *  Everything else is pinned identically across circuits. */
export async function validateConfig(value: unknown): Promise<{ config: ProtocolConfig; circuit: Circuit }> {
  const cfg = object(value)
  if (
    !cfg ||
    !exactKeys(cfg, [
      'baseUrl',
      'games',
      'maxPlies',
      'retries',
      'commentary',
      'includePreviousGames',
      'maxTokens',
      'promptHash',
      'players',
    ])
  )
    throw new Error('Invalid ranked match configuration.')

  const circuit = typeof cfg.maxTokens === 'number' ? circuitFor(cfg.maxTokens) : null
  if (!circuit) throw new Error('This match does not use a ranked completion budget.')

  // Series length only sets sample size, so it is a range rather than a pin —
  // but an even one, so colors come out level. See isRankedGameCount.
  if (typeof cfg.games !== 'number' || !isRankedGameCount(cfg.games))
    throw new Error(`A ranked series runs an even ${RANKED_GAMES_MIN} to ${RANKED_GAMES_MAX} games.`)

  if (
    cfg.baseUrl !== 'https://openrouter.ai/api/v1' ||
    cfg.maxPlies !== 200 ||
    cfg.retries !== RANKED_RETRIES ||
    cfg.commentary !== true ||
    cfg.includePreviousGames !== true ||
    cfg.promptHash !== (await expectedPromptHash())
  )
    throw new Error('This match does not use a ranked protocol.')

  if (!Array.isArray(cfg.players) || cfg.players.length !== 2)
    throw new Error('Exactly two models are required.')

  const players = cfg.players.map((raw) => {
    const player = object(raw)
    if (!player || !exactKeys(player, ['model', 'effort', 'temperature']))
      throw new Error('Invalid model configuration.')
    if (typeof player.model !== 'string' || !MODEL_RE.test(player.model) || player.model.toLowerCase() === 'random')
      throw new Error('Invalid model identifier.')
    if (typeof player.effort !== 'string' || !EFFORT_RE.test(player.effort))
      throw new Error('Invalid reasoning effort.')
    if (player.temperature !== RANKED_TEMPERATURE)
      throw new Error(`Ranked temperature must be ${RANKED_TEMPERATURE}.`)
    return { model: player.model, effort: player.effort, temperature: RANKED_TEMPERATURE }
  }) as ProtocolConfig['players']

  if (players[0].model === players[1].model) throw new Error('A model cannot play itself in a ranked match.')

  return {
    circuit,
    config: {
      baseUrl: 'https://openrouter.ai/api/v1',
      games: cfg.games,
      maxPlies: 200,
      retries: RANKED_RETRIES,
      commentary: true,
      includePreviousGames: true,
      maxTokens: circuit.maxTokens,
      promptHash: cfg.promptHash as string,
      players,
    },
  }
}

function validateTerminal(chess: Chess, game: SubmittedGame) {
  const draw = game.result === '1/2-1/2'
  switch (game.reason) {
    case 'checkmate': {
      if (!chess.isCheckmate() || draw) throw new Error(`Game ${game.index + 1} is not a checkmate.`)
      const expected = chess.turn() === 'w' ? '0-1' : '1-0'
      if (game.result !== expected) throw new Error(`Game ${game.index + 1} has the wrong checkmate result.`)
      return
    }
    case 'stalemate':
      if (!draw || !chess.isStalemate()) throw new Error(`Game ${game.index + 1} is not a stalemate.`)
      return
    case 'insufficient_material':
      if (!draw || !chess.isInsufficientMaterial())
        throw new Error(`Game ${game.index + 1} does not have insufficient material.`)
      return
    case 'threefold_repetition':
      if (!draw || !chess.isThreefoldRepetition())
        throw new Error(`Game ${game.index + 1} is not a threefold repetition.`)
      return
    case 'fifty_move_rule':
      if (!draw || !chess.isDrawByFiftyMoves())
        throw new Error(`Game ${game.index + 1} does not satisfy the fifty-move rule.`)
      return
    case 'move_limit':
      if (!draw || game.plies !== 200 || chess.isGameOver())
        throw new Error(`Game ${game.index + 1} is not a valid move-limit draw.`)
      return
    case 'illegal_forfeit':
      if (draw || chess.isGameOver()) throw new Error(`Game ${game.index + 1} is not a valid illegal-move forfeit.`)
      if (game.result !== (chess.turn() === 'w' ? '0-1' : '1-0'))
        throw new Error(`Game ${game.index + 1} awards an illegal-move forfeit to the wrong side.`)
      return
    case 'draw':
      if (!draw || !chess.isDraw()) throw new Error(`Game ${game.index + 1} is not a drawn position.`)
  }
}

function validateGame(value: unknown, index: number): SubmittedGame {
  const game = object(value)
  if (!game || !exactKeys(game, ['index', 'white', 'result', 'reason', 'plies', 'pgn']))
    throw new Error(`Game ${index + 1} has an invalid shape.`)
  if (game.index !== index || game.white !== index % 2)
    throw new Error(`Game ${index + 1} has an invalid color assignment.`)
  if (!['1-0', '0-1', '1/2-1/2'].includes(String(game.result)))
    throw new Error(`Game ${index + 1} has an invalid result.`)
  if (
    ![
      'checkmate',
      'stalemate',
      'insufficient_material',
      'threefold_repetition',
      'fifty_move_rule',
      'draw',
      'move_limit',
      'illegal_forfeit',
    ].includes(String(game.reason))
  )
    throw new Error(`Game ${index + 1} has an invalid ending reason.`)
  if (!Number.isInteger(game.plies) || (game.plies as number) < 0 || (game.plies as number) > 200)
    throw new Error(`Game ${index + 1} has an invalid ply count.`)
  if (typeof game.pgn !== 'string' || game.pgn.length > 25_000)
    throw new Error(`Game ${index + 1} has an invalid PGN.`)

  const normalized = {
    index,
    white: game.white,
    result: game.result,
    reason: game.reason,
    plies: game.plies,
    pgn: game.pgn.trim(),
  } as SubmittedGame

  const chess = new Chess()
  try {
    chess.loadPgn(normalized.pgn, { strict: true })
  } catch {
    throw new Error(`Game ${index + 1} contains an illegal or malformed PGN.`)
  }
  if (chess.history().length !== normalized.plies)
    throw new Error(`Game ${index + 1} does not match its ply count.`)
  validateTerminal(chess, normalized)
  return normalized
}

export async function validateSubmission(value: unknown): Promise<ValidatedSubmission> {
  const body = object(value)
  if (
    !body ||
    !exactKeys(body, [
      'schemaVersion',
      'appVersion',
      'protocol',
      'installationId',
      'ticket',
      'turnstileToken',
      'config',
      'games',
    ])
  )
    throw new Error('Invalid submission.')
  if (body.schemaVersion !== 1 || typeof body.protocol !== 'string')
    throw new Error('Unsupported leaderboard protocol.')
  if (body.appVersion !== LEADERBOARD_APP_VERSION)
    throw new Error('Please refresh Grand Tensor before submitting.')
  if (typeof body.installationId !== 'string' || !UUID_RE.test(body.installationId))
    throw new Error('Invalid anonymous installation identifier.')
  if (typeof body.ticket !== 'string' || body.ticket.length > 4096)
    throw new Error('Invalid run ticket.')
  if (typeof body.turnstileToken !== 'string' || body.turnstileToken.length > 2048)
    throw new Error('Invalid anti-bot token.')

  // The bucket comes from the config's own cap, so a submission cannot claim a
  // circuit it didn't play in — it can only disagree with itself and be refused.
  const { config, circuit } = await validateConfig(body.config)
  if (body.protocol !== circuit.id) throw new Error('Submission protocol does not match its settings.')
  // The config declares the series length and the ticket is signed over the
  // config, so the game list has to match what was declared before play started.
  if (!Array.isArray(body.games) || body.games.length !== config.games)
    throw new Error(`This submission does not contain its declared ${config.games} games.`)
  const games = body.games.map(validateGame)

  let scoreAX2 = 0
  let winsA = 0
  let drawsA = 0
  let lossesA = 0
  for (const game of games) {
    if (game.result === '1/2-1/2') {
      scoreAX2 += 1
      drawsA++
      continue
    }
    const winner = game.result === '1-0' ? game.white : 1 - game.white
    if (winner === 0) {
      scoreAX2 += 2
      winsA++
    } else {
      lossesA++
    }
  }

  const canonicalObject = {
    schemaVersion: 1,
    appVersion: body.appVersion,
    protocol: body.protocol,
    config,
    games,
  }

  return {
    appVersion: body.appVersion,
    protocol: body.protocol,
    installationId: body.installationId,
    ticket: body.ticket,
    turnstileToken: body.turnstileToken,
    config,
    circuit,
    games,
    scoreAX2,
    scoreBX2: 2 * games.length - scoreAX2,
    winsA,
    drawsA,
    lossesA,
    canonical: JSON.stringify(canonicalObject),
  }
}
