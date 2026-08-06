import {
  CIRCUITS,
  circuitById,
  circuitFor,
  DEFAULT_CIRCUIT,
  entrantKey,
  type Circuit,
  type EntrantResponse,
  type EntrantSeries,
  type HeadToHead,
  type ProtocolConfig,
  type Standing,
} from '../src/leaderboard-protocol'
import { MIN_OPPONENTS, rateEntrants, sortStandings, type SeriesResult } from './rating'
import { sha256, validateConfig, validateSubmission } from './validation'

type Env = {
  DB: D1Database
  SUBMIT_RATE_LIMITER: RateLimit
  TURNSTILE_SITE_KEY: string
  TURNSTILE_SECRET: string
  RUN_TICKET_SECRET: string
  ABUSE_HASH_SECRET: string
  CORS_ORIGINS: string
}

type TicketPayload = {
  version: 1
  protocol: string
  configHash: string
  issuedAt: number
  expiresAt: number
  nonce: string
}

const encoder = new TextEncoder()
const decoder = new TextDecoder()
const TICKET_LIFETIME_MS = 6 * 60 * 60 * 1000
const WINDOW_DAYS = 30

/** How long a submitter may withdraw a result. Deletion exists to undo a mistake,
 *  not to curate a record: an open-ended window lets anyone submit every series
 *  and then delete the losses, which bends the standings without a single
 *  fabricated game. Short enough that the only thing it can undo is a misclick. */
const DELETE_WINDOW_MS = 15 * 60 * 1000

/** Per browser, per model pairing, per day. Sized so a full effort sweep of one
 *  matchup (three levels, both directions) fits in a single sitting. */
const INSTALL_DAILY_PAIR_QUOTA = 8

function base64url(bytes: Uint8Array) {
  let raw = ''
  for (const byte of bytes) raw += String.fromCharCode(byte)
  return btoa(raw).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

function fromBase64url(value: string) {
  const padded = value.replace(/-/g, '+').replace(/_/g, '/') + '='.repeat((4 - (value.length % 4)) % 4)
  const raw = atob(padded)
  return Uint8Array.from(raw, (char) => char.charCodeAt(0))
}

async function hmac(secret: string, value: string) {
  const key = await crypto.subtle.importKey('raw', encoder.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, [
    'sign',
    'verify',
  ])
  return new Uint8Array(await crypto.subtle.sign('HMAC', key, encoder.encode(value)))
}

async function signTicket(env: Env, config: ProtocolConfig, circuit: Circuit) {
  const now = Date.now()
  const payload: TicketPayload = {
    version: 1,
    protocol: circuit.id,
    configHash: await sha256(JSON.stringify(config)),
    issuedAt: now,
    expiresAt: now + TICKET_LIFETIME_MS,
    nonce: crypto.randomUUID(),
  }
  const encoded = base64url(encoder.encode(JSON.stringify(payload)))
  const signature = base64url(await hmac(env.RUN_TICKET_SECRET, encoded))
  return `${encoded}.${signature}`
}

async function verifyTicket(env: Env, ticket: string, config: ProtocolConfig) {
  const [encoded, signature, extra] = ticket.split('.')
  if (!encoded || !signature || extra) return false
  const expected = await hmac(env.RUN_TICKET_SECRET, encoded)
  const actual = fromBase64url(signature)
  if (expected.length !== actual.length) return false
  let mismatch = 0
  expected.forEach((byte, index) => (mismatch |= byte ^ actual[index]))
  if (mismatch !== 0) return false

  let payload: TicketPayload
  try {
    payload = JSON.parse(decoder.decode(fromBase64url(encoded))) as TicketPayload
  } catch {
    return false
  }
  const now = Date.now()
  return (
    payload.version === 1 &&
    payload.protocol === circuitFor(config.maxTokens)?.id &&
    payload.issuedAt <= now &&
    payload.expiresAt >= now &&
    payload.expiresAt - payload.issuedAt === TICKET_LIFETIME_MS &&
    payload.configHash === (await sha256(JSON.stringify(config)))
  )
}

function allowedOrigin(request: Request, env: Env) {
  const origin = request.headers.get('Origin') ?? ''
  return env.CORS_ORIGINS.split(',')
    .map((value) => value.trim())
    .filter(Boolean)
    .includes(origin)
    ? origin
    : null
}

function corsHeaders(origin: string | null) {
  const headers = new Headers({
    'Content-Type': 'application/json; charset=utf-8',
    'X-Content-Type-Options': 'nosniff',
    'Referrer-Policy': 'no-referrer',
  })
  if (origin) {
    headers.set('Access-Control-Allow-Origin', origin)
    headers.set('Access-Control-Allow-Methods', 'GET, POST, DELETE, OPTIONS')
    headers.set('Access-Control-Allow-Headers', 'Content-Type, Authorization')
    headers.set('Access-Control-Max-Age', '86400')
    headers.set('Vary', 'Origin')
  }
  return headers
}

function json(data: unknown, status = 200, origin: string | null = null, cache?: string) {
  const headers = corsHeaders(origin)
  if (cache) headers.set('Cache-Control', cache)
  return Response.json(data, { status, headers })
}

async function readJson(request: Request) {
  const length = Number(request.headers.get('Content-Length') ?? 0)
  if (length > 120_000) throw new Error('Submission is too large.')
  const text = await request.text()
  if (text.length > 120_000) throw new Error('Submission is too large.')
  return JSON.parse(text) as unknown
}

async function validateKnownModels(config: ProtocolConfig) {
  const response = await fetch('https://openrouter.ai/api/v1/models', {
    headers: { Accept: 'application/json' },
    cf: { cacheEverything: true, cacheTtl: 3600 },
  })
  if (!response.ok) throw new Error('Model registry is temporarily unavailable.')
  const data = (await response.json()) as { data?: { id?: unknown }[] }
  const ids = new Set((data.data ?? []).flatMap((model) => (typeof model.id === 'string' ? [model.id] : [])))
  if (config.players.some((player) => !ids.has(player.model)))
    throw new Error('Both models must be current OpenRouter model identifiers.')
}

async function verifyTurnstile(request: Request, env: Env, token: string) {
  const response = await fetch('https://challenges.cloudflare.com/turnstile/v0/siteverify', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      secret: env.TURNSTILE_SECRET,
      response: token,
      remoteip: request.headers.get('CF-Connecting-IP') ?? '',
    }),
  })
  if (!response.ok) return false
  const result = (await response.json()) as { success?: boolean; action?: string; hostname?: string }
  const validHostnames = new Set(['grandtensor.shantanugoel.com', 'localhost', '127.0.0.1'])
  return result.success === true && result.action === 'leaderboard_submit' && validHostnames.has(result.hostname ?? '')
}

async function anonymizedHash(secret: string, value: string) {
  return base64url(await hmac(secret, value))
}

async function issueTicket(request: Request, env: Env, origin: string) {
  const { config, circuit } = await validateConfig(await readJson(request))
  await validateKnownModels(config)
  const network = request.headers.get('CF-Connecting-IP') ?? 'unknown'
  const burstKey = await anonymizedHash(env.ABUSE_HASH_SECRET, network)
  const { success } = await env.SUBMIT_RATE_LIMITER.limit({ key: `ticket:${burstKey}` })
  if (!success) return json({ error: 'Too many leaderboard requests. Try again shortly.' }, 429, origin)
  return json({ ticket: await signTicket(env, config, circuit), protocol: circuit.id }, 201, origin)
}

async function submit(request: Request, env: Env, origin: string) {
  const submission = await validateSubmission(await readJson(request))
  if (!(await verifyTicket(env, submission.ticket, submission.config)))
    return json({ error: 'This run ticket is invalid or expired.' }, 403, origin)
  if (!(await verifyTurnstile(request, env, submission.turnstileToken)))
    return json({ error: 'Anti-bot verification failed. Please try again.' }, 403, origin)
  await validateKnownModels(submission.config)

  const ip = request.headers.get('CF-Connecting-IP') ?? 'unknown'
  const date = new Date().toISOString().slice(0, 10)
  const installHash = await anonymizedHash(env.ABUSE_HASH_SECRET, `install:${date}:${submission.installationId}`)
  const networkHash = await anonymizedHash(env.ABUSE_HASH_SECRET, `network:${date}:${ip}`)
  const pair = [...submission.config.players.map((player) => player.model)].sort().join('|')
  const pairHash = await sha256(pair)
  const burstKey = await anonymizedHash(env.ABUSE_HASH_SECRET, ip)
  const { success } = await env.SUBMIT_RATE_LIMITER.limit({ key: `submit:${burstKey}` })
  if (!success) return json({ error: 'Too many submissions. Try again shortly.' }, 429, origin)

  const dayStart = Date.parse(`${date}T00:00:00.000Z`)
  const [installQuota, networkQuota] = await Promise.all([
    env.DB.prepare(
      'SELECT COUNT(*) AS count FROM submissions WHERE created_at >= ? AND install_hash = ? AND pair_hash = ?',
    )
      .bind(dayStart, installHash, pairHash)
      .first<{ count: number }>(),
    env.DB.prepare('SELECT COUNT(*) AS count FROM submissions WHERE created_at >= ? AND network_hash = ?')
      .bind(dayStart, networkHash)
      .first<{ count: number }>(),
  ])
  // Keyed on the two model ids, deliberately not on effort. The ranking entity
  // is (model, effort), but the thing a farmer manipulates is the matchup — and
  // folding effort in here would multiply one browser's daily ceiling by the
  // number of effort combinations instead of holding it flat.
  if ((installQuota?.count ?? 0) >= INSTALL_DAILY_PAIR_QUOTA)
    return json({ error: 'This browser has contributed enough results for this matchup today.' }, 429, origin)
  if ((networkQuota?.count ?? 0) >= 100)
    return json({ error: 'This network has reached today’s anonymous contribution limit.' }, 429, origin)

  const contentHash = await sha256(submission.canonical)
  const id = crypto.randomUUID()
  const deleteToken = `${crypto.randomUUID()}${crypto.randomUUID()}`
  const deleteHash = await sha256(deleteToken)
  const now = Date.now()

  try {
    await env.DB.prepare(
      `INSERT INTO submissions (
        id, content_hash, protocol, app_version, created_at,
        model_a, effort_a, model_b, effort_b,
        score_a_x2, score_b_x2, wins_a, draws_a, losses_a, games,
        payload_json, install_hash, network_hash, pair_hash, delete_hash
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
      .bind(
        id,
        contentHash,
        submission.protocol,
        submission.appVersion,
        now,
        submission.config.players[0].model,
        submission.config.players[0].effort,
        submission.config.players[1].model,
        submission.config.players[1].effort,
        submission.scoreAX2,
        submission.scoreBX2,
        submission.winsA,
        submission.drawsA,
        submission.lossesA,
        submission.games.length,
        submission.canonical,
        installHash,
        networkHash,
        pairHash,
        deleteHash,
      )
      .run()
  } catch (error) {
    if (error instanceof Error && /unique/i.test(error.message))
      return json({ error: 'This result has already been submitted.' }, 409, origin)
    throw error
  }

  return json({ id, deleteToken, message: `Result added to the ${submission.circuit.name}.` }, 201, origin)
}

const DISCLOSURE =
  'Community-reported matches. PGN legality and board results are checked; model identity is not cryptographically verified.'

type SeriesRow = {
  created_at: number
  model_a: string
  effort_a: string
  model_b: string
  effort_b: string
  wins_a: number
  draws_a: number
  losses_a: number
}

/** Every series in the window for one circuit. The rating fit is a fold over all
 *  of them, so they are read whole rather than pre-aggregated in SQL — grouping
 *  in the query would throw away exactly the opponent identities the fit needs. */
function windowSeries(env: Env, circuit: Circuit) {
  return env.DB.prepare(
    `SELECT created_at, model_a, effort_a, model_b, effort_b, wins_a, draws_a, losses_a
     FROM submissions WHERE protocol = ? AND created_at >= ?`,
  )
    .bind(circuit.id, Date.now() - WINDOW_DAYS * 24 * 60 * 60 * 1000)
    .all<SeriesRow>()
}

const asSeriesResult = (row: SeriesRow): SeriesResult => ({
  a: { model: row.model_a, effort: row.effort_a },
  b: { model: row.model_b, effort: row.effort_b },
  wins: row.wins_a,
  draws: row.draws_a,
  losses: row.losses_a,
})

async function standings(env: Env, origin: string | null, circuitId: string | null) {
  const circuit = circuitId ? circuitById(circuitId) : DEFAULT_CIRCUIT
  if (!circuit) return json({ error: 'Unknown circuit.' }, 400, origin)

  const { results } = await windowSeries(env, circuit)
  const rated = sortStandings(rateEntrants(results.map(asSeriesResult)))

  let rank = 0
  const rows: Standing[] = rated.slice(0, 100).map((entrant) => ({
    rank: entrant.provisional ? null : ++rank,
    model: entrant.model,
    effort: entrant.effort,
    rating: entrant.rating,
    ratingMargin: entrant.ratingMargin,
    provisional: entrant.provisional,
    opponents: entrant.opponents,
    points: entrant.points,
    games: entrant.games,
    series: entrant.series,
    wins: entrant.wins,
    draws: entrant.draws,
    losses: entrant.losses,
    scorePct: entrant.scorePct,
  }))

  return json(
    {
      protocol: circuit.id,
      circuit: { id: circuit.id, name: circuit.name, maxTokens: circuit.maxTokens, blurb: circuit.blurb },
      windowDays: WINDOW_DAYS,
      disclosure: DISCLOSURE,
      minOpponents: MIN_OPPONENTS,
      standings: rows,
    },
    200,
    origin,
    'public, max-age=60, stale-while-revalidate=300',
  )
}

/** One entrant's record broken out by opponent, so anyone can see whether a
 *  rating was earned against the field or farmed against one weak model. */
async function entrant(
  env: Env,
  origin: string | null,
  circuitId: string | null,
  model: string | null,
  effort: string | null,
) {
  const circuit = circuitId ? circuitById(circuitId) : DEFAULT_CIRCUIT
  if (!circuit) return json({ error: 'Unknown circuit.' }, 400, origin)
  if (!model || !effort || model.length > 200 || effort.length > 32)
    return json({ error: 'An entrant is identified by model and effort.' }, 400, origin)

  const self = entrantKey({ model, effort })
  const { results } = await windowSeries(env, circuit)

  const opponents = new Map<string, HeadToHead>()
  const history: EntrantSeries[] = []
  let wins = 0
  let draws = 0
  let losses = 0

  for (const row of results) {
    const a = { model: row.model_a, effort: row.effort_a }
    const b = { model: row.model_b, effort: row.effort_b }
    const isA = entrantKey(a) === self
    if (!isA && entrantKey(b) !== self) continue

    const mine = isA ? row.wins_a : row.losses_a
    const theirs = isA ? row.losses_a : row.wins_a
    const other = isA ? b : a

    wins += mine
    draws += row.draws_a
    losses += theirs
    history.push({
      playedAt: row.created_at,
      opponentModel: other.model,
      opponentEffort: other.effort,
      games: mine + row.draws_a + theirs,
      wins: mine,
      draws: row.draws_a,
      losses: theirs,
    })

    const key = entrantKey(other)
    const record =
      opponents.get(key) ??
      ({ model: other.model, effort: other.effort, series: 0, games: 0, wins: 0, draws: 0, losses: 0, scorePct: 0 } satisfies HeadToHead)
    record.series += 1
    record.games += mine + row.draws_a + theirs
    record.wins += mine
    record.draws += row.draws_a
    record.losses += theirs
    opponents.set(key, record)
  }

  if (!history.length) return json({ error: 'No results for this entrant in the current window.' }, 404, origin)

  const pct = (w: number, d: number, total: number) => (total ? Math.round(((w + d / 2) / total) * 1000) / 10 : 0)
  const games = wins + draws + losses
  const body: EntrantResponse = {
    circuit: { id: circuit.id, name: circuit.name, maxTokens: circuit.maxTokens, blurb: circuit.blurb },
    model,
    effort,
    games,
    series: history.length,
    wins,
    draws,
    losses,
    scorePct: pct(wins, draws, games),
    headToHead: [...opponents.values()]
      .map((record) => ({ ...record, scorePct: pct(record.wins, record.draws, record.games) }))
      .sort((x, y) => y.games - x.games || x.model.localeCompare(y.model)),
    history: history.sort((x, y) => y.playedAt - x.playedAt).slice(0, 100),
  }

  return json(body, 200, origin, 'public, max-age=60, stale-while-revalidate=300')
}

async function removeSubmission(request: Request, env: Env, origin: string, id: string) {
  const token = request.headers.get('Authorization')?.replace(/^Bearer\s+/i, '')
  if (!token || token.length > 200) return json({ error: 'Missing deletion token.' }, 401, origin)
  const deleteHash = await sha256(token)
  const result = await env.DB.prepare(
    'DELETE FROM submissions WHERE id = ? AND delete_hash = ? AND created_at >= ?',
  )
    .bind(id, deleteHash, Date.now() - DELETE_WINDOW_MS)
    .run()
  if (result.meta.changes) return json({ deleted: true }, 200, origin)

  // Separated so an expired window doesn't read as a bad token. A row that still
  // exists and matches the token is simply past the point of being withdrawable.
  const stale = await env.DB.prepare('SELECT 1 FROM submissions WHERE id = ? AND delete_hash = ?')
    .bind(id, deleteHash)
    .first()
  if (stale)
    return json(
      { error: `A submitted result can only be withdrawn within ${DELETE_WINDOW_MS / 60_000} minutes.` },
      403,
      origin,
    )
  return json({ error: 'Submission not found.' }, 404, origin)
}

export default {
  async fetch(request, env): Promise<Response> {
    const url = new URL(request.url)
    const origin = allowedOrigin(request, env)

    if (request.method === 'OPTIONS')
      return origin ? new Response(null, { status: 204, headers: corsHeaders(origin) }) : new Response(null, { status: 403 })
    if (request.method !== 'GET' && !origin) return json({ error: 'Origin not allowed.' }, 403)

    try {
      if (request.method === 'GET' && url.pathname === '/v1/config')
        return json({ siteKey: env.TURNSTILE_SITE_KEY, circuits: CIRCUITS }, 200, origin, 'public, max-age=3600')
      if (request.method === 'GET' && url.pathname === '/v1/standings')
        return standings(env, origin, url.searchParams.get('circuit'))
      if (request.method === 'GET' && url.pathname === '/v1/entrant')
        return entrant(
          env,
          origin,
          url.searchParams.get('circuit'),
          url.searchParams.get('model'),
          url.searchParams.get('effort'),
        )
      if (request.method === 'POST' && url.pathname === '/v1/run-ticket') return issueTicket(request, env, origin!)
      if (request.method === 'POST' && url.pathname === '/v1/submissions') return submit(request, env, origin!)
      const deletion = url.pathname.match(/^\/v1\/submissions\/([0-9a-f-]{36})$/i)
      if (request.method === 'DELETE' && deletion) return removeSubmission(request, env, origin!, deletion[1])
      return json({ error: 'Not found.' }, 404, origin)
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Unexpected leaderboard error.'
      const clientError = /invalid|unsupported|required|standard|model|match|game|submission|large|refresh/i.test(message)
      return json({ error: clientError ? message : 'Leaderboard service is temporarily unavailable.' }, clientError ? 400 : 500, origin)
    }
  },
} satisfies ExportedHandler<Env>
