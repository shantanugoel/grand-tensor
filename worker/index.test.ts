/** End-to-end tests for the Worker's HTTP surface, against real SQLite running
 *  the real migration. Everything here goes through `worker.fetch` — the routing,
 *  the CORS gate, ticket signing, Turnstile, the quota conditions on the INSERT,
 *  the rating fit, and how a result is dated. */

import { afterEach, describe, expect, test } from 'bun:test'
import worker from './index'
import { harness, ORIGIN, request, type Harness } from './harness'
import {
  DEFAULT_CIRCUIT,
  LEADERBOARD_APP_VERSION,
  RANKED_RETRIES,
  type ProtocolConfig,
} from '../src/leaderboard-protocol'
import { expectedPromptHash } from './validation'

let live: Harness | null = null
afterEach(() => {
  live?.restore()
  live = null
})

const start = (overrides?: Record<string, unknown>) => (live = harness(overrides))

async function config(over: Partial<ProtocolConfig> = {}): Promise<ProtocolConfig> {
  return {
    baseUrl: 'https://openrouter.ai/api/v1',
    games: 4,
    maxPlies: 200,
    retries: RANKED_RETRIES,
    commentary: true,
    includePreviousGames: true,
    maxTokens: DEFAULT_CIRCUIT.maxTokens,
    promptHash: await expectedPromptHash(),
    players: [
      { model: 'vendor/model-a', effort: 'default', temperature: 0.2 },
      { model: 'vendor/model-b', effort: 'high', temperature: 0.2 },
    ],
    ...over,
  }
}

/** Black mates in every game, so whoever is seated as A loses every one. */
const games = (length: number, pgn = '1. f3 e5 2. g4 Qh4#') =>
  Array.from({ length }, (_, index) => ({
    index,
    white: (index % 2) as 0 | 1,
    result: '0-1' as const,
    reason: 'checkmate' as const,
    plies: 4,
    pgn,
  }))

const post = (h: Harness, path: string, body: unknown, init: RequestInit & { origin?: string | null } = {}) =>
  worker.fetch(request(path, { method: 'POST', body: JSON.stringify(body), ...init }), h.env as any, {} as any)

async function ticketFor(h: Harness, cfg: ProtocolConfig) {
  const response = await post(h, '/api/v1/run-ticket', cfg)
  const body = (await response.json()) as { ticket: string; protocol: string; error?: string }
  if (!response.ok) throw new Error(`ticket refused: ${body.error}`)
  return body
}

/** A complete, valid submission. `seed` varies the PGN so each one hashes
 *  differently, since identical content is deduplicated by design. */
async function submit(
  h: Harness,
  over: {
    cfg?: ProtocolConfig
    installationId?: string
    ip?: string
    seed?: number
    gameList?: ReturnType<typeof games>
  } = {},
) {
  const cfg = over.cfg ?? (await config())
  const { ticket } = await ticketFor(h, cfg)
  // A distinct but still-mating line per seed, so content hashes differ.
  const openings = ['1. f3 e5 2. g4 Qh4#', '1. g4 e5 2. f3 Qh4#', '1. f4 e6 2. g4 Qh4#', '1. f3 e6 2. g4 Qh4#']
  const list = over.gameList ?? games(cfg.games, openings[(over.seed ?? 0) % openings.length])
  const response = await post(
    h,
    '/api/v1/submissions',
    {
      schemaVersion: 1,
      appVersion: LEADERBOARD_APP_VERSION,
      protocol: DEFAULT_CIRCUIT.id,
      installationId: over.installationId ?? '0198a530-7b3c-7d21-8f47-6381c9d9d643',
      ticket,
      turnstileToken: 'token',
      config: cfg,
      games: list,
    },
    over.ip ? { headers: { 'CF-Connecting-IP': over.ip } } : {},
  )
  return { response, body: (await response.json()) as any }
}

describe('routing and CORS', () => {
  test('serves config and reflects an allowed origin', async () => {
    const h = start()
    const response = await worker.fetch(request('/api/v1/config'), h.env as any, {} as any)
    expect(response.status).toBe(200)
    expect(response.headers.get('Access-Control-Allow-Origin')).toBe(ORIGIN)
    const body = (await response.json()) as any
    expect(body.siteKey).toBe('site-key')
    expect(body.circuits.map((c: any) => c.id)).toEqual(['standard', 'extended'])
  })

  test('refuses a write from an origin that is not allowed', async () => {
    const h = start()
    const response = await post(h, '/api/v1/run-ticket', await config(), { origin: 'https://evil.example' })
    expect(response.status).toBe(403)
    expect((await response.json()).error).toContain('Origin not allowed')
  })

  test('preflights only for allowed origins', async () => {
    const h = start()
    const ok = await worker.fetch(request('/api/v1/submissions', { method: 'OPTIONS' }), h.env as any, {} as any)
    expect(ok.status).toBe(204)
    const bad = await worker.fetch(
      request('/api/v1/submissions', { method: 'OPTIONS', origin: 'https://evil.example' }),
      h.env as any,
      {} as any,
    )
    expect(bad.status).toBe(403)
  })

  test('404s an unknown path', async () => {
    const h = start()
    expect((await worker.fetch(request('/api/v1/nope'), h.env as any, {} as any)).status).toBe(404)
  })

  test('does not expose API routes outside the /api namespace', async () => {
    const h = start()
    expect((await worker.fetch(request('/v1/config'), h.env as any, {} as any)).status).toBe(404)
  })
})

describe('run tickets', () => {
  test('issues a ticket bound to the circuit the cap selects', async () => {
    const h = start()
    const { protocol, ticket } = await ticketFor(h, await config())
    expect(protocol).toBe('standard')
    expect(ticket.split('.')).toHaveLength(2)

    const extended = await ticketFor(h, await config({ maxTokens: 32000 }))
    expect(extended.protocol).toBe('extended')
  })

  test('refuses a config that is not ranked', async () => {
    const h = start()
    const response = await post(h, '/api/v1/run-ticket', await config({ retries: 1 }))
    expect(response.status).toBe(400)
    expect((await response.json()).error).toContain('ranked protocol')
  })

  test('refuses a model the registry does not list', async () => {
    const h = start()
    h.registry.models = ['vendor/model-a']
    const response = await post(h, '/api/v1/run-ticket', await config())
    expect(response.status).toBe(400)
    expect((await response.json()).error).toContain('current OpenRouter model identifiers')
  })

  test('reports a registry outage as a server error, not the caller’s fault', async () => {
    const h = start()
    h.registry.ok = false
    const response = await post(h, '/api/v1/run-ticket', await config())
    // The old regex classifier saw the word "model" and called this a 400.
    expect(response.status).toBe(500)
    expect((await response.json()).error).toContain('temporarily unavailable')
  })

  test('applies the burst rate limit', async () => {
    const h = start()
    h.rateLimit.allow = false
    expect((await post(h, '/api/v1/run-ticket', await config())).status).toBe(429)
  })
})

describe('submission', () => {
  test('accepts a valid series and stores exactly one row', async () => {
    const h = start()
    const { response, body } = await submit(h)
    expect(response.status).toBe(201)
    expect(body.message).toContain('Standard Circuit')
    // Nothing is handed back that could withdraw the row later.
    expect(body.deleteToken).toBeUndefined()

    const row = h.database.query('SELECT * FROM submissions').get() as any
    expect(row.protocol).toBe('standard')
    expect(row.games).toBe(4)
    expect(row.model_a).toBe('vendor/model-a')
    // Black mates every game and colors alternate, so A takes 2 of 4.
    expect(row.wins_a).toBe(2)
    expect(row.losses_a).toBe(2)
    expect(row.score_a_x2).toBe(4)
  })

  test('never stores anything the client was promised would not be uploaded', async () => {
    const h = start()
    await submit(h)
    const row = h.database.query('SELECT * FROM submissions').get() as any
    const stored = JSON.stringify(row)
    for (const secret of ['apiKey', 'sk-', 'Alpha', 'temperature":0.2,"label'])
      expect(stored).not.toContain(secret)
    // The payload keeps the config and the games, and nothing else.
    expect(Object.keys(JSON.parse(row.payload_json)).sort()).toEqual([
      'appVersion',
      'config',
      'games',
      'protocol',
      'schemaVersion',
    ])
  })

  test('refuses a forged ticket', async () => {
    const h = start()
    const cfg = await config()
    const response = await post(h, '/api/v1/submissions', {
      schemaVersion: 1,
      appVersion: LEADERBOARD_APP_VERSION,
      protocol: DEFAULT_CIRCUIT.id,
      installationId: '0198a530-7b3c-7d21-8f47-6381c9d9d643',
      ticket: 'bm90LWEtdGlja2V0.bm90LWEtc2ln',
      turnstileToken: 'token',
      config: cfg,
      games: games(4),
    })
    expect(response.status).toBe(403)
    expect((await response.json()).error).toContain('not valid for this match')
  })

  test('refuses a ticket issued for a different config', async () => {
    const h = start()
    const { ticket } = await ticketFor(h, await config())
    // Same ticket, but the match that was actually played used 6 games.
    const response = await post(h, '/api/v1/submissions', {
      schemaVersion: 1,
      appVersion: LEADERBOARD_APP_VERSION,
      protocol: DEFAULT_CIRCUIT.id,
      installationId: '0198a530-7b3c-7d21-8f47-6381c9d9d643',
      ticket,
      turnstileToken: 'token',
      config: await config({ games: 6 }),
      games: games(6),
    })
    expect(response.status).toBe(403)
  })

  test('refuses a failed, mis-actioned, or foreign-hostname Turnstile token', async () => {
    for (const [label, patch] of [
      ['failure', { pass: false }],
      ['wrong action', { action: 'something_else' }],
      // The localhost bypass this replaced: a token solved on a machine the
      // operator does not control must not be accepted by production.
      ['foreign hostname', { hostname: 'localhost' }],
    ] as const) {
      const h = start()
      Object.assign(h.turnstile, patch)
      const { response } = await submit(h)
      expect(`${label}:${response.status}`).toBe(`${label}:403`)
      expect(h.database.query('SELECT COUNT(*) AS n FROM submissions').get() as any).toMatchObject({ n: 0 })
      h.restore()
    }
  })

  test('deduplicates an identical result', async () => {
    const h = start()
    expect((await submit(h)).response.status).toBe(201)
    const repeat = await submit(h)
    expect(repeat.response.status).toBe(409)
    expect(repeat.body.error).toContain('already been submitted')
    expect((h.database.query('SELECT COUNT(*) AS n FROM submissions').get() as any).n).toBe(1)
  })

  test('rejects an oversized body before parsing it', async () => {
    const h = start()
    const response = await post(h, '/api/v1/submissions', { padding: 'x'.repeat(130_000) })
    expect(response.status).toBe(400)
    expect((await response.json()).error).toContain('too large')
  })

  test('rejects a body that is not JSON', async () => {
    const h = start()
    const response = await worker.fetch(
      request('/api/v1/submissions', { method: 'POST', body: 'not json at all' }),
      h.env as any,
      {} as any,
    )
    expect(response.status).toBe(400)
    expect((await response.json()).error).toContain('not valid JSON')
  })
})

describe('daily quotas', () => {
  /** A filler row, written by column name rather than positionally so a future
   *  migration cannot silently shift a value into the wrong column. Binds are
   *  created_at, played_at, install_hash, network_hash, pair_hash. */
  const pad = (id: string) =>
    `INSERT INTO submissions (
       id, content_hash, protocol, app_version, created_at, played_at,
       model_a, effort_a, model_b, effort_b,
       score_a_x2, score_b_x2, wins_a, draws_a, losses_a, games,
       payload_json, install_hash, network_hash, pair_hash
     ) VALUES ('${id}','hash-${id}','standard','1.0.0',?,?,'vendor/model-a','default','vendor/model-b','high',
       4,4,2,0,2,4,'{}',?,?,?)`

  test('caps one browser on one matchup, and counts pairings independently', async () => {
    const h = start()
    // The quota is 8; four distinct 4-game series is all the distinct PGNs the
    // helper has, so drive it with distinct opponents instead and assert the
    // ceiling on repeated identical pairings via the counter directly.
    for (let seed = 0; seed < 4; seed++) {
      const { response } = await submit(h, { seed })
      expect(response.status).toBe(201)
    }
    expect((h.database.query('SELECT COUNT(*) AS n FROM submissions').get() as any).n).toBe(4)

    // Backfill to the ceiling, then the next real submission must be refused.
    const row = h.database.query('SELECT install_hash, pair_hash FROM submissions LIMIT 1').get() as any
    for (let i = 0; i < 4; i++) h.database.run(pad(`pad${i}`), [Date.now(), Date.now(), row.install_hash, 'net', row.pair_hash])

    const blocked = await submit(h, { seed: 99 })
    expect(blocked.response.status).toBe(429)
    expect(blocked.body.error).toContain('this matchup today')

    // A different matchup from the same browser is unaffected.
    const other = await submit(h, {
      cfg: await config({
        players: [
          { model: 'vendor/model-c', effort: 'default', temperature: 0.2 },
          { model: 'vendor/model-d', effort: 'high', temperature: 0.2 },
        ],
      }),
    })
    expect(other.response.status).toBe(201)
  })

  test('caps a network across every matchup', async () => {
    const h = start()
    const first = await submit(h)
    expect(first.response.status).toBe(201)
    const row = h.database.query('SELECT network_hash FROM submissions LIMIT 1').get() as any
    for (let i = 0; i < 100; i++)
      h.database.run(pad(`n${i}`), [Date.now(), Date.now(), 'other-install', row.network_hash, `pair${i}`])

    const blocked = await submit(h, { seed: 1, installationId: '0198a530-7b3c-7d21-8f47-000000000001' })
    expect(blocked.response.status).toBe(429)
    expect(blocked.body.error).toContain('network')
  })
})

describe('submitting long after the match', () => {
  /** Rewrites the ticket's own timestamp and re-signs it, which is the only way
   *  to simulate a run that finished hours or weeks ago: the server issues the
   *  ticket, so `issuedAt` is not something a test can pass in. */
  async function aged(h: Harness, cfg: ProtocolConfig, issuedAt: number) {
    const { ticket } = await ticketFor(h, cfg)
    const [encoded] = ticket.split('.')
    const payload = { ...JSON.parse(Buffer.from(encoded, 'base64url').toString()), issuedAt }
    const body = Buffer.from(JSON.stringify(payload)).toString('base64url')
    const key = await crypto.subtle.importKey(
      'raw',
      new TextEncoder().encode(h.env.RUN_TICKET_SECRET),
      { name: 'HMAC', hash: 'SHA-256' },
      false,
      ['sign'],
    )
    const signature = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(body))
    return `${body}.${Buffer.from(new Uint8Array(signature)).toString('base64url')}`
  }

  const withTicket = (h: Harness, cfg: ProtocolConfig, ticket: string, list: ReturnType<typeof games>) =>
    post(h, '/api/v1/submissions', {
      schemaVersion: 1,
      appVersion: LEADERBOARD_APP_VERSION,
      protocol: DEFAULT_CIRCUIT.id,
      installationId: '0198a530-7b3c-7d21-8f47-6381c9d9d643',
      ticket,
      turnstileToken: 'token',
      config: cfg,
      games: list,
    })

  test('accepts a result whose ticket was issued days ago', async () => {
    const h = start()
    const cfg = await config()
    const threeDays = Date.now() - 3 * 24 * 60 * 60 * 1000
    const response = await withTicket(h, cfg, await aged(h, cfg, threeDays), games(4))
    expect(response.status).toBe(201)

    // Dated to the match, not to the upload — and the upload time is still kept,
    // because the daily quotas are counted on it.
    const row = h.database.query('SELECT created_at, played_at FROM submissions').get() as any
    expect(row.played_at).toBe(threeDays)
    expect(row.created_at).toBeGreaterThan(threeDays)
  })

  test('a result plays into the window of the day it was played, not the day it was sent', async () => {
    const h = start()
    const cfg = await config()
    const ancient = Date.now() - 29 * 24 * 60 * 60 * 1000
    expect((await withTicket(h, cfg, await aged(h, cfg, ancient), games(4))).status).toBe(201)

    // Inside the window today; the next test's clock would push it out.
    const body = (await (await worker.fetch(request('/api/v1/standings'), h.env as any, {} as any)).json()) as any
    expect(body.standings.length).toBe(2)
  })

  test('refuses a match older than the standings window rather than storing an invisible row', async () => {
    const h = start()
    const cfg = await config()
    const response = await withTicket(h, cfg, await aged(h, cfg, Date.now() - 31 * 24 * 60 * 60 * 1000), games(4))
    expect(response.status).toBe(409)
    expect((await response.json()).error).toContain('30-day standings window')
    expect((h.database.query('SELECT COUNT(*) AS n FROM submissions').get() as any).n).toBe(0)
  })

  /** The client keeps an unsubmitted result in local storage and has to decide
   *  whether a refusal is worth holding it for. Only these two are terminal, and
   *  the difference is carried by the code rather than by the status or the
   *  prose — 409 covers both a duplicate and a stale match, and 403 covers both
   *  a bad ticket and a failed challenge. */
  test('labels every refusal with a code, and only stale and duplicate are terminal', async () => {
    const h = start()
    const cfg = await config()
    const code = async (response: Response) => ({ status: response.status, code: (await response.json()).code })

    expect(await code(await withTicket(h, cfg, 'not.aticket', games(4)))).toEqual({ status: 403, code: 'ticket' })
    expect(await code(await withTicket(h, cfg, await aged(h, cfg, Date.now() - 31 * 864e5), games(4)))).toEqual({
      status: 409,
      code: 'stale',
    })

    // `submit` has already read these bodies, so they are inspected in hand.
    expect((await submit(h)).response.status).toBe(201)
    const repeat = await submit(h)
    expect([repeat.response.status, repeat.body.code]).toEqual([409, 'duplicate'])

    h.turnstile.pass = false
    const challenged = await submit(h, { seed: 1 })
    expect([challenged.response.status, challenged.body.code]).toEqual([403, 'turnstile'])
    h.turnstile.pass = true

    // The limiter gates ticket issuance too, so the ticket is taken first.
    const spare = await aged(h, cfg, Date.now() - 1000)
    h.rateLimit.allow = false
    expect(await code(await withTicket(h, cfg, spare, games(4, '1. g4 e5 2. f3 Qh4#')))).toEqual({
      status: 429,
      code: 'rate_limited',
    })
  })

  test('refuses a ticket dated in the future', async () => {
    const h = start()
    const cfg = await config()
    const response = await withTicket(h, cfg, await aged(h, cfg, Date.now() + 60 * 60 * 1000), games(4))
    expect(response.status).toBe(403)
  })

  test('deduplicates the same result no matter how much later the second copy arrives', async () => {
    const h = start()
    const cfg = await config()
    expect((await withTicket(h, cfg, await aged(h, cfg, Date.now() - 60 * 60 * 1000), games(4))).status).toBe(201)
    // A different ticket for the same games: the content hash covers the result
    // alone, so the second copy is refused however it was authorised.
    const repeat = await withTicket(h, cfg, await aged(h, cfg, Date.now() - 30 * 60 * 1000), games(4))
    expect(repeat.status).toBe(409)
    expect((await repeat.json()).error).toContain('already been submitted')
    expect((h.database.query('SELECT COUNT(*) AS n FROM submissions').get() as any).n).toBe(1)
  })

  test('no longer exposes a way to withdraw a submitted result', async () => {
    const h = start()
    const { body } = await submit(h)
    const response = await worker.fetch(
      request(`/api/v1/submissions/${body.id}`, {
        method: 'DELETE',
        headers: { Authorization: 'Bearer anything-at-all' },
      }),
      h.env as any,
      {} as any,
    )
    expect(response.status).toBe(404)
    expect((h.database.query('SELECT COUNT(*) AS n FROM submissions').get() as any).n).toBe(1)
  })
})

describe('standings and entrant records', () => {
  /** Builds a connected field: a beats b, b beats c, a beats c. */
  async function field(h: Harness) {
    const pairs: [string, string][] = [
      ['vendor/model-a', 'vendor/model-b'],
      ['vendor/model-b', 'vendor/model-c'],
      ['vendor/model-a', 'vendor/model-c'],
      ['vendor/model-a', 'vendor/model-d'],
      ['vendor/model-b', 'vendor/model-d'],
      ['vendor/model-c', 'vendor/model-d'],
    ]
    let seed = 0
    for (const [x, y] of pairs) {
      const { response } = await submit(h, {
        cfg: await config({
          players: [
            { model: x, effort: 'default', temperature: 0.2 },
            { model: y, effort: 'default', temperature: 0.2 },
          ],
        }),
        seed: seed++,
        installationId: `0198a530-7b3c-7d21-8f47-63000000000${seed}`,
        ip: `203.0.113.${10 + seed}`,
      })
      expect(response.status).toBe(201)
    }
  }

  test('rates a connected field and ranks it', async () => {
    const h = start()
    await field(h)
    const response = await worker.fetch(request('/api/v1/standings'), h.env as any, {} as any)
    expect(response.status).toBe(200)
    expect(response.headers.get('Cache-Control')).toContain('max-age=60')

    const body = (await response.json()) as any
    expect(body.protocol).toBe('standard')
    expect(body.windowDays).toBe(30)
    expect(body.disclosure).toContain('not cryptographically verified')
    expect(body.standings.length).toBe(4)

    // Every entrant has 3 distinct opponents here, so all are ranked.
    expect(body.standings.every((s: any) => !s.provisional)).toBe(true)
    expect(body.standings.map((s: any) => s.rank)).toEqual([1, 2, 3, 4])
    // Ratings are anchored so the rated field averages 1500.
    const mean = body.standings.reduce((t: number, s: any) => t + s.rating, 0) / body.standings.length
    expect(Math.abs(mean - 1500)).toBeLessThan(1)
    // Descending, and each carries an interval.
    for (let i = 1; i < body.standings.length; i++)
      expect(body.standings[i - 1].rating).toBeGreaterThanOrEqual(body.standings[i].rating)
    expect(body.standings[0].ratingMargin).toBeGreaterThan(0)
  })

  test('keeps circuits in separate tables', async () => {
    const h = start()
    await submit(h)
    const extended = await worker.fetch(request('/api/v1/standings?circuit=extended'), h.env as any, {} as any)
    expect(((await extended.json()) as any).standings).toEqual([])

    const standard = await worker.fetch(request('/api/v1/standings?circuit=standard'), h.env as any, {} as any)
    expect(((await standard.json()) as any).standings.length).toBe(2)
  })

  test('refuses an unknown circuit', async () => {
    const h = start()
    const response = await worker.fetch(request('/api/v1/standings?circuit=nope'), h.env as any, {} as any)
    expect(response.status).toBe(400)
    expect((await response.json()).error).toContain('Unknown circuit')
  })

  test('serves an empty board before anyone has played', async () => {
    const h = start()
    const body = (await (await worker.fetch(request('/api/v1/standings'), h.env as any, {} as any)).json()) as any
    expect(body.standings).toEqual([])
  })

  test('breaks an entrant’s record out by opponent', async () => {
    const h = start()
    await field(h)
    const response = await worker.fetch(
      request('/api/v1/entrant?model=vendor%2Fmodel-a&effort=default'),
      h.env as any,
      {} as any,
    )
    expect(response.status).toBe(200)
    const body = (await response.json()) as any
    expect(body.model).toBe('vendor/model-a')
    expect(body.series).toBe(3)
    expect(body.games).toBe(12)
    expect(body.headToHead.map((o: any) => o.model).sort()).toEqual([
      'vendor/model-b',
      'vendor/model-c',
      'vendor/model-d',
    ])
    expect(body.wins + body.draws + body.losses).toBe(body.games)
  })

  test('404s an entrant with no results in the window', async () => {
    const h = start()
    await submit(h)
    const response = await worker.fetch(
      request('/api/v1/entrant?model=vendor%2Fmodel-z&effort=default'),
      h.env as any,
      {} as any,
    )
    expect(response.status).toBe(404)
  })

  test('requires both halves of an entrant key', async () => {
    const h = start()
    const response = await worker.fetch(request('/api/v1/entrant?model=vendor%2Fmodel-a'), h.env as any, {} as any)
    expect(response.status).toBe(400)
  })

  test('excludes results played longer ago than the window', async () => {
    const h = start()
    await submit(h)
    // Aged on play time, with the upload left as recent as it really was: an old
    // match does not come back into the window by being submitted today.
    h.database.run('UPDATE submissions SET played_at = ?', [Date.now() - 31 * 24 * 60 * 60 * 1000])
    const body = (await (await worker.fetch(request('/api/v1/standings'), h.env as any, {} as any)).json()) as any
    expect(body.standings).toEqual([])
  })
})
