import {
  CIRCUITS,
  circuitById,
  circuitFor,
  DEFAULT_CIRCUIT,
  entrantKey,
  LEADERBOARD_WINDOW_DAYS,
  type Circuit,
  type EntrantResponse,
  type EntrantSeries,
  type HeadToHead,
  type ProtocolConfig,
  type Standing,
} from '../src/leaderboard-protocol'
import { MIN_OPPONENTS, rateEntrants, sortStandings, type SeriesResult } from './rating'
import { ClientError } from './errors'
import { sha256, validateConfig, validateSubmission } from './validation'

/** Substituted at deploy time by the `deploy` script. A bare
 *  `wrangler deploy` or `wrangler dev` performs no substitution and leaves the
 *  identifier undeclared, so it can only be read through `typeof`. */
declare const BUILD_SHA: string
const BUILD = typeof BUILD_SHA === 'undefined' ? 'unknown' : BUILD_SHA

type Env = {
  DB: D1Database
  SUBMIT_RATE_LIMITER: RateLimit
  TURNSTILE_SITE_KEY: string
  TURNSTILE_SECRET: string
  /** Comma-separated hostnames a Turnstile token may have been solved on. */
  TURNSTILE_HOSTNAMES: string
  RUN_TICKET_SECRET: string
  ABUSE_HASH_SECRET: string
  CORS_ORIGINS: string
}

/** Tickets issued before the deadline was removed also carry an `expiresAt`,
 *  which is simply ignored: the signature covers the encoded blob as it was
 *  written, so an extra field costs nothing and old tickets keep verifying. */
type TicketPayload = {
  version: 1
  protocol: string
  configHash: string
  /** When the ticket was issued, which is when the match started — the only
   *  timestamp for a match that the server can attest to rather than be told. */
  issuedAt: number
  nonce: string
}

const encoder = new TextEncoder()
const decoder = new TextDecoder()
const WINDOW_DAYS = LEADERBOARD_WINDOW_DAYS
const WINDOW_MS = WINDOW_DAYS * 24 * 60 * 60 * 1000

/** The whole window is read into the Worker on a standings cache miss, because
 *  the rating fit needs opponent identities that a GROUP BY would throw away.
 *  Nothing else bounds that read, so this does — newest first, so growth past
 *  the ceiling drops the oldest results rather than failing the request. */
const WINDOW_SERIES_LIMIT = 20_000

/** Per browser, per model pairing, per day. Sized so a full effort sweep of one
 *  matchup (three levels, both directions) fits in a single sitting. */
const INSTALL_DAILY_PAIR_QUOTA = 8

/** Per network, per day, across every matchup. */
const NETWORK_DAILY_QUOTA = 100

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
  const payload: TicketPayload = {
    version: 1,
    protocol: circuit.id,
    configHash: await sha256(JSON.stringify(config)),
    issuedAt: Date.now(),
    nonce: crypto.randomUUID(),
  }
  const encoded = base64url(encoder.encode(JSON.stringify(payload)))
  const signature = base64url(await hmac(env.RUN_TICKET_SECRET, encoded))
  return `${encoded}.${signature}`
}

/** A ticket no longer expires. It never guarded much on its own — Turnstile, the
 *  daily quotas, the content-hash uniqueness and the PGN replay are what actually
 *  bound abuse — and the one thing a deadline reliably did was refuse the honest
 *  case: a series that finished while its owner was away from the machine. What
 *  the ticket still does is bind the config that was validated before play to the
 *  submission that claims to have played it, and carry a server-issued timestamp
 *  for when that was. Returns the payload so the caller can date the result. */
async function verifyTicket(env: Env, ticket: string, config: ProtocolConfig): Promise<TicketPayload | null> {
  const [encoded, signature, extra] = ticket.split('.')
  if (!encoded || !signature || extra) return null
  const expected = await hmac(env.RUN_TICKET_SECRET, encoded)
  const actual = fromBase64url(signature)
  if (expected.length !== actual.length) return null
  let mismatch = 0
  expected.forEach((byte, index) => (mismatch |= byte ^ actual[index]))
  if (mismatch !== 0) return null

  let payload: TicketPayload
  try {
    payload = JSON.parse(decoder.decode(fromBase64url(encoded))) as TicketPayload
  } catch {
    return null
  }
  const valid =
    payload.version === 1 &&
    payload.protocol === circuitFor(config.maxTokens)?.id &&
    Number.isFinite(payload.issuedAt) &&
    payload.issuedAt <= Date.now() &&
    payload.configHash === (await sha256(JSON.stringify(config)))
  return valid ? payload : null
}

const list = (value: string) =>
  value
    .split(',')
    .map((entry) => entry.trim())
    .filter(Boolean)

function allowedOrigin(request: Request, env: Env) {
  const origin = request.headers.get('Origin') ?? ''
  return list(env.CORS_ORIGINS).includes(origin) ? origin : null
}

function corsHeaders(origin: string | null) {
  const headers = new Headers({
    'Content-Type': 'application/json; charset=utf-8',
    'X-Content-Type-Options': 'nosniff',
    'Referrer-Policy': 'no-referrer',
  })
  if (origin) {
    headers.set('Access-Control-Allow-Origin', origin)
    headers.set('Access-Control-Allow-Methods', 'GET, POST, OPTIONS')
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

const MAX_BODY_BYTES = 120_000

async function readJson(request: Request) {
  const length = Number(request.headers.get('Content-Length') ?? 0)
  if (length > MAX_BODY_BYTES) throw new ClientError('Submission is too large.')
  const text = await request.text()
  if (text.length > MAX_BODY_BYTES) throw new ClientError('Submission is too large.')
  try {
    return JSON.parse(text) as unknown
  } catch {
    throw new ClientError('Submission is not valid JSON.')
  }
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
    throw new ClientError('Both models must be current OpenRouter model identifiers.')
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
  // The hostname a token was solved on is the one gate here that a caller cannot
  // forge: Origin is a request header, so anything outside a browser sets it to
  // whatever it likes. Which hostnames count is therefore environment config, not
  // a constant — production must not carry the localhost entries that let anyone
  // serving the app on their own machine submit to the real board.
  return (
    result.success === true &&
    result.action === 'leaderboard_submit' &&
    list(env.TURNSTILE_HOSTNAMES).includes(result.hostname ?? '')
  )
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

/** Refusals carry a `code` as well as a message, because the client now keeps an
 *  unsubmitted result in local storage and has to decide whether to keep holding
 *  it. `stale` and `duplicate` are the two that will never succeed on a retry;
 *  everything else is worth waiting out, and the difference is not something a
 *  status code or a prose message can be relied on to carry. */
async function submit(request: Request, env: Env, origin: string) {
  const submission = await validateSubmission(await readJson(request))
  const ticket = await verifyTicket(env, submission.ticket, submission.config)
  if (!ticket) return json({ error: 'This run ticket is not valid for this match.', code: 'ticket' }, 403, origin)

  // The one bound left on ticket age, and it is the standings window rather than
  // a deadline: a result older than the window can never appear in a table, so
  // accepting it would be storing a row and reporting a success for something
  // nobody will ever see. Saying so is more honest than a silent 201.
  if (ticket.issuedAt < Date.now() - WINDOW_MS)
    return json(
      {
        error: `This match is older than the ${WINDOW_DAYS}-day standings window and can no longer be counted.`,
        code: 'stale',
      },
      409,
      origin,
    )

  if (!(await verifyTurnstile(request, env, submission.turnstileToken)))
    return json({ error: 'Anti-bot verification failed. Please try again.', code: 'turnstile' }, 403, origin)
  await validateKnownModels(submission.config)

  const ip = request.headers.get('CF-Connecting-IP') ?? 'unknown'
  const date = new Date().toISOString().slice(0, 10)
  const installHash = await anonymizedHash(env.ABUSE_HASH_SECRET, `install:${date}:${submission.installationId}`)
  const networkHash = await anonymizedHash(env.ABUSE_HASH_SECRET, `network:${date}:${ip}`)
  const pair = [...submission.config.players.map((player) => player.model)].sort().join('|')
  const pairHash = await sha256(pair)
  const burstKey = await anonymizedHash(env.ABUSE_HASH_SECRET, ip)
  const { success } = await env.SUBMIT_RATE_LIMITER.limit({ key: `submit:${burstKey}` })
  if (!success) return json({ error: 'Too many submissions. Try again shortly.', code: 'rate_limited' }, 429, origin)

  const dayStart = Date.parse(`${date}T00:00:00.000Z`)
  const contentHash = await sha256(submission.canonical)
  const id = crypto.randomUUID()
  const now = Date.now()

  // The quotas are conditions on the INSERT rather than queries in front of it.
  // Two submissions arriving together each used to read a count from before the
  // other's row existed, so both passed a ceiling only one of them was under;
  // SQLite evaluates these subqueries as part of the same statement, so the
  // second one sees the first.
  //
  // The install quota is keyed on the two model ids, deliberately not on effort.
  // The ranking entity is (model, effort), but the thing a farmer manipulates is
  // the matchup — folding effort in here would multiply one browser's daily
  // ceiling by the number of effort combinations instead of holding it flat.
  // Both are counted on `created_at`, i.e. today's uploads, not on when the
  // matches were played: a backdated `played_at` is under the submitter's control
  // in the sense that matters here, since nothing stops someone holding a stack
  // of finished runs and releasing them together.
  //
  // `content_hash` is the dedup, and it hashes the result alone — config plus
  // games, no ticket and no identity. So the same series submitted twice is one
  // row whether it arrives twice in a minute or twice a week apart, and a replay
  // of somebody else's PGNs under a fresh ticket is refused for the same reason.
  try {
    const inserted = await env.DB.prepare(
      `INSERT INTO submissions (
        id, content_hash, protocol, app_version, created_at, played_at,
        model_a, effort_a, model_b, effort_b,
        score_a_x2, score_b_x2, wins_a, draws_a, losses_a, games,
        payload_json, install_hash, network_hash, pair_hash
      )
      SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?
      WHERE (SELECT COUNT(*) FROM submissions WHERE created_at >= ? AND install_hash = ? AND pair_hash = ?) < ?
        AND (SELECT COUNT(*) FROM submissions WHERE created_at >= ? AND network_hash = ?) < ?`,
    )
      .bind(
        id,
        contentHash,
        submission.protocol,
        submission.appVersion,
        now,
        ticket.issuedAt,
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
        dayStart,
        installHash,
        pairHash,
        INSTALL_DAILY_PAIR_QUOTA,
        dayStart,
        networkHash,
        NETWORK_DAILY_QUOTA,
      )
      .run()

    // No row means a quota condition failed. Which one is worth saying, and this
    // path is rare enough to afford the extra read.
    if (!inserted.meta.changes) return quotaRefusal(env, origin, dayStart, installHash, pairHash)
  } catch (error) {
    if (error instanceof Error && /unique/i.test(error.message))
      return json({ error: 'This result has already been submitted.', code: 'duplicate' }, 409, origin)
    throw error
  }

  return json({ id, message: `Result added to the ${submission.circuit.name}.` }, 201, origin)
}

async function quotaRefusal(env: Env, origin: string, dayStart: number, installHash: string, pairHash: string) {
  const installed = await env.DB.prepare(
    'SELECT COUNT(*) AS count FROM submissions WHERE created_at >= ? AND install_hash = ? AND pair_hash = ?',
  )
    .bind(dayStart, installHash, pairHash)
    .first<{ count: number }>()
  return (installed?.count ?? 0) >= INSTALL_DAILY_PAIR_QUOTA
    ? json({ error: 'This browser has contributed enough results for this matchup today.', code: 'quota' }, 429, origin)
    : json({ error: 'This network has reached today’s anonymous contribution limit.', code: 'quota' }, 429, origin)
}

const DISCLOSURE =
  'Community-reported matches. PGN legality and board results are checked; model identity is not cryptographically verified.'

type SeriesRow = {
  played_at: number
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
 *  in the query would throw away exactly the opponent identities the fit needs.
 *
 *  Windowed on when the games were played, not when they were uploaded, so a
 *  result submitted the next morning still describes the day it was actually
 *  played — and one submitted a month later ages out on its own schedule instead
 *  of arriving in the window brand new. */
function windowSeries(env: Env, circuit: Circuit) {
  return env.DB.prepare(
    `SELECT played_at, model_a, effort_a, model_b, effort_b, wins_a, draws_a, losses_a
     FROM submissions WHERE protocol = ? AND played_at >= ?
     ORDER BY played_at DESC LIMIT ?`,
  )
    .bind(circuit.id, Date.now() - WINDOW_MS, WINDOW_SERIES_LIMIT)
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
      playedAt: row.played_at,
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

export default {
  async fetch(request, env): Promise<Response> {
    const url = new URL(request.url)
    const origin = allowedOrigin(request, env)

    if (request.method === 'OPTIONS')
      return origin ? new Response(null, { status: 204, headers: corsHeaders(origin) }) : new Response(null, { status: 403 })
    if (request.method !== 'GET' && !origin) return json({ error: 'Origin not allowed.' }, 403)

    // Every route below is awaited, not returned bare. `return handler(...)`
    // hands back a pending promise, and a promise rejecting after the try block
    // has already exited is not caught by it — which made this whole catch dead
    // code for the async routes. A validation refusal reached the client as an
    // opaque runtime 500 instead of the 400 and the message it was written to
    // give, and every route here is async.
    try {
      // The Worker deploys by hand, separately from the site, so it needs its
      // own way to answer which commit is live. `no-store` because a cached
      // answer to that question is a wrong one.
      if (request.method === 'GET' && url.pathname === '/version')
        return json({ build: BUILD }, 200, origin, 'no-store')
      if (request.method === 'GET' && url.pathname === '/api/v1/config')
        return json({ siteKey: env.TURNSTILE_SITE_KEY, circuits: CIRCUITS }, 200, origin, 'public, max-age=3600')
      if (request.method === 'GET' && url.pathname === '/api/v1/standings')
        return await standings(env, origin, url.searchParams.get('circuit'))
      if (request.method === 'GET' && url.pathname === '/api/v1/entrant')
        return await entrant(
          env,
          origin,
          url.searchParams.get('circuit'),
          url.searchParams.get('model'),
          url.searchParams.get('effort'),
        )
      if (request.method === 'POST' && url.pathname === '/api/v1/run-ticket')
        return await issueTicket(request, env, origin!)
      if (request.method === 'POST' && url.pathname === '/api/v1/submissions')
        return await submit(request, env, origin!)
      return json({ error: 'Not found.' }, 404, origin)
    } catch (error) {
      if (error instanceof ClientError) return json({ error: error.message }, 400, origin)
      return json({ error: 'Leaderboard service is temporarily unavailable.' }, 500, origin)
    }
  },
} satisfies ExportedHandler<Env>
