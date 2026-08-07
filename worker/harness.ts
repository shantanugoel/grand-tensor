/** Test harness for the Worker: a D1 shim, a rate limiter, and a stub for the
 *  two outbound calls (`/models` and Turnstile siteverify).
 *
 *  The database is real SQLite running the real migration, so CHECK constraints,
 *  the UNIQUE on content_hash and the conditional-INSERT quotas are all exercised
 *  as they will be in production rather than mocked away. */

import { Database } from 'bun:sqlite'
import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

/** Every migration, in the order Wrangler would apply them — read from the
 *  directory rather than named one by one, so adding one cannot leave the tests
 *  passing against a schema production no longer has. */
const MIGRATIONS_DIR = join(import.meta.dir, 'migrations')
const MIGRATIONS = readdirSync(MIGRATIONS_DIR)
  .filter((name) => name.endsWith('.sql'))
  .sort()
  .map((name) => readFileSync(join(MIGRATIONS_DIR, name), 'utf8'))

/** Just enough of D1's surface for worker/index.ts: prepare/bind/run/first/all,
 *  and the `meta.changes` the quota path reads to tell a refusal from a write. */
export function d1(database: Database) {
  return {
    prepare(sql: string) {
      const statement = { args: [] as unknown[] }
      const api = {
        bind(...args: unknown[]) {
          statement.args = args
          return api
        },
        async run() {
          const result = database.prepare(sql).run(...(statement.args as never[]))
          return { meta: { changes: result.changes } }
        },
        async first<T>() {
          return (database.prepare(sql).get(...(statement.args as never[])) ?? null) as T | null
        },
        async all<T>() {
          return { results: database.prepare(sql).all(...(statement.args as never[])) as T[] }
        },
      }
      return api
    },
  }
}

export type Harness = {
  env: any
  database: Database
  /** Requests the stubbed outbound fetch has seen, newest last. */
  calls: string[]
  /** Flip to make Turnstile reject, or to fail the model registry. */
  turnstile: { pass: boolean; action: string; hostname: string }
  registry: { models: string[]; ok: boolean }
  rateLimit: { allow: boolean }
  restore: () => void
}

export function harness(overrides: Record<string, unknown> = {}): Harness {
  const database = new Database(':memory:')
  // Each file runs whole, not split on ';': the migrations carry comments, and
  // splitting leaves comment-only fragments that are not statements.
  for (const migration of MIGRATIONS) database.run(migration)

  const calls: string[] = []
  const turnstile = { pass: true, action: 'leaderboard_submit', hostname: 'grandtensor.shantanugoel.com' }
  const registry = { models: ['vendor/model-a', 'vendor/model-b', 'vendor/model-c', 'vendor/model-d'], ok: true }
  const rateLimit = { allow: true }

  const realFetch = globalThis.fetch
  globalThis.fetch = (async (url: any, init?: any) => {
    const href = String(url)
    calls.push(href)
    if (href.includes('openrouter.ai')) {
      if (!registry.ok) return new Response('upstream down', { status: 503 })
      return Response.json({ data: registry.models.map((id) => ({ id })) })
    }
    if (href.includes('challenges.cloudflare.com')) {
      return Response.json({ success: turnstile.pass, action: turnstile.action, hostname: turnstile.hostname })
    }
    return realFetch(url, init)
  }) as typeof fetch

  const env = {
    DB: d1(database),
    SUBMIT_RATE_LIMITER: { limit: async () => ({ success: rateLimit.allow }) },
    TURNSTILE_SITE_KEY: 'site-key',
    TURNSTILE_SECRET: 'secret',
    TURNSTILE_HOSTNAMES: 'grandtensor.shantanugoel.com',
    RUN_TICKET_SECRET: 'ticket-secret',
    ABUSE_HASH_SECRET: 'abuse-secret',
    CORS_ORIGINS: 'https://grandtensor.shantanugoel.com',
    ...overrides,
  }

  return { env, database, calls, turnstile, registry, rateLimit, restore: () => (globalThis.fetch = realFetch) }
}

export const ORIGIN = 'https://grandtensor.shantanugoel.com'

export function request(path: string, init: RequestInit & { origin?: string | null } = {}) {
  const headers = new Headers(init.headers)
  if (init.origin !== null) headers.set('Origin', init.origin ?? ORIGIN)
  headers.set('CF-Connecting-IP', headers.get('CF-Connecting-IP') ?? '203.0.113.7')
  if (init.body) headers.set('Content-Type', 'application/json')
  return new Request(`https://leaderboard.example${path}`, { ...init, headers })
}
