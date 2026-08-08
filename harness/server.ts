/** An OpenAI-compatible endpoint backed by local agent CLIs.
 *
 *  Grand Tensor talks to one thing: POST {baseUrl}/chat/completions, with an
 *  optional GET {baseUrl}/models for the catalog. Speak both and the arena has
 *  no idea it is driving `claude -p` instead of a hosted model — which is the
 *  whole design. Nothing in src/ knows this file exists.
 *
 *  Matches played against it are exhibitions by construction: ranked play pins
 *  the base URL to OpenRouter, and both the client and the Worker enforce that
 *  (src/leaderboard-protocol.ts, worker/validation.ts). There is no path from
 *  here to the standings.
 *
 *  Usage:
 *    bun run harness/server.ts
 *    bun run harness/server.ts --config harness/harnesses.toml --port 8199
 *    bun run harness/server.ts --host 0.0.0.0 --token secret --cert c.pem --key k.pem
 */

import { resolve } from 'node:path'
import { Catalog } from './catalog'
import { loadConfig, resolveModel, type HarnessDef } from './config'
import { HarnessError, message, run, type ChatMessage } from './run'

type Args = Record<string, string | boolean>

function parseArgs(argv: string[]): Args {
  const out: Args = {}
  for (let i = 0; i < argv.length; i++) {
    if (!argv[i].startsWith('--')) continue
    const key = argv[i].slice(2)
    const next = argv[i + 1]
    if (next && !next.startsWith('--')) (out[key] = next), i++
    else out[key] = true
  }
  return out
}

const args = parseArgs(Bun.argv.slice(2))
const port = Number(args.port ?? Bun.env.HARNESS_PORT ?? 8199)
const host = String(args.host ?? Bun.env.HARNESS_HOST ?? '127.0.0.1')
const token = String(args.token ?? Bun.env.HARNESS_TOKEN ?? '')
const root = resolve(String(args.root ?? import.meta.dir))
const ttl = Number(args['models-ttl'] ?? 300) * 1000
const configPath = args.config ? resolve(String(args.config)) : await defaultConfigPath()

async function defaultConfigPath(): Promise<string | undefined> {
  for (const name of ['harnesses.toml', 'harnesses.json']) {
    const path = resolve(import.meta.dir, name)
    if (await Bun.file(path).exists()) return path
  }
  return undefined
}

const loopback = host === '127.0.0.1' || host === 'localhost' || host === '::1'
if (!loopback && !token) {
  // This server runs local binaries on text that arrives over HTTP. On loopback
  // that is the operator talking to themselves; on a LAN it is anyone who can
  // reach the port, so a shared secret stops being optional.
  console.error(`Refusing to bind ${host} without --token. Anyone who can reach the port could run these CLIs.`)
  process.exit(1)
}

const { harnesses, source } = await loadConfig(configPath)
const byId = new Map(harnesses.map((h) => [h.id, h]))
const catalog = new Catalog(harnesses, ttl)

/** Bearer only, and never cookies, so `*` gives away nothing a browser wouldn't
 *  already send. The Private Network header is what lets an https page reach a
 *  private address at all under Chrome's private-network rules. */
function cors(req: Request): Record<string, string> {
  const headers: Record<string, string> = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers': 'authorization, content-type, x-title, http-referer',
    'Access-Control-Max-Age': '86400',
  }
  if (req.headers.get('Access-Control-Request-Private-Network') === 'true')
    headers['Access-Control-Allow-Private-Network'] = 'true'
  return headers
}

const json = (body: unknown, req: Request, status = 200) =>
  Response.json(body, { status, headers: cors(req) })

/** The shape src/llm.ts reads on a failure: it looks for `error.message` and
 *  decides retryability from the status. */
const fail = (msg: string, req: Request, status = 500) =>
  json({ error: { message: msg, type: 'harness_error' } }, req, status)

const authorized = (req: Request) =>
  !token || req.headers.get('Authorization')?.replace(/^Bearer\s+/i, '') === token

async function completions(req: Request): Promise<Response> {
  let body: any
  try {
    body = await req.json()
  } catch {
    return fail('Request body was not JSON.', req, 400)
  }

  const requested = typeof body?.model === 'string' ? body.model : ''
  const target = resolveModel(byId, requested)
  if (!target) {
    const known = [...byId.keys()].join(', ')
    return fail(`No harness named "${requested.split('/')[0] || '(empty)'}". Configured: ${known}.`, req, 400)
  }

  const messages: ChatMessage[] = Array.isArray(body.messages)
    ? body.messages.filter((m: any) => typeof m?.content === 'string')
    : []
  if (!messages.length) return fail('No messages in request.', req, 400)

  try {
    const result = await run({
      harness: target.harness,
      model: target.model,
      messages,
      // `default` sends no field at all and `off` arrives as `none`; both are
      // handled downstream by resolveEffort.
      effort: typeof body.reasoning_effort === 'string' ? body.reasoning_effort : undefined,
      temperature: typeof body.temperature === 'number' ? body.temperature : undefined,
      maxTokens: typeof body.max_tokens === 'number' ? body.max_tokens : undefined,
      signal: req.signal,
      root,
    })

    const total = result.input + result.output
    console.log(
      `${requested} → ${Math.round(result.ms)}ms, ${total || '?'} tokens${result.cost ? `, $${result.cost.toFixed(4)}` : ''}`,
    )

    return json(
      {
        id: `harness-${crypto.randomUUID()}`,
        object: 'chat.completion',
        created: Math.floor(Date.now() / 1000),
        model: requested,
        choices: [
          { index: 0, message: { role: 'assistant', content: result.text }, finish_reason: result.finish },
        ],
        usage: {
          prompt_tokens: result.input,
          completion_tokens: result.output,
          total_tokens: total,
          completion_tokens_details: { reasoning_tokens: result.reasoning },
          cost: result.cost,
        },
      },
      req,
    )
  } catch (err) {
    if (req.signal.aborted) return fail('Aborted', req, 499)
    const status = err instanceof HarnessError ? err.status : 502
    console.error(`${requested} → ${message(err)}`)
    return fail(message(err), req, status)
  }
}

const server = Bun.serve({
  port,
  hostname: host,
  // Agents think for minutes. Bun's default idle timeout would hang up first,
  // and the app would read that as a dropped connection.
  idleTimeout: 255,
  tls:
    args.cert && args.key
      ? { cert: Bun.file(String(args.cert)), key: Bun.file(String(args.key)) }
      : undefined,
  async fetch(req) {
    const url = new URL(req.url)
    // Accepted with or without the /v1 prefix, because both are things people
    // type into a "Base URL" box.
    const path = url.pathname.replace(/^\/v1/, '') || '/'

    if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: cors(req) })
    if (!authorized(req)) return fail('Bad or missing API key.', req, 401)

    if (path === '/models' && req.method === 'GET') return json({ data: await catalog.list() }, req)
    if (path === '/chat/completions' && req.method === 'POST') return completions(req)
    if (path === '/')
      return json(
        {
          service: 'grand-tensor-harness',
          config: source ?? '(built-ins only)',
          harnesses: harnesses.filter((h) => h.enabled).map((h) => h.id),
        },
        req,
      )

    return fail(`No route for ${req.method} ${url.pathname}`, req, 404)
  },
})

const scheme = args.cert && args.key ? 'https' : 'http'
const base = `${scheme}://${host === '0.0.0.0' ? 'localhost' : host}:${server.port}/v1`

console.log(`\nGrand Tensor harness → ${base}`)
console.log(`Config: ${source ?? 'built-ins only'}`)
if (token) console.log('Auth: required — paste the token into the API key field.')
console.log('\nPaste that base URL into Settings → Endpoint. Matches are exhibitions, never ranked.\n')

// Model counts are resolved rather than described, because a discovery command
// whose output stopped parsing still "works" — it just quietly returns four junk
// ids instead of fifty-three real ones, and nothing downstream can tell. A count
// here is the one place that shows up before a match rather than during one.
for (const harness of harnesses) {
  if (!harness.enabled) {
    console.log(`  ✗ ${harness.id.padEnd(12)} disabled in config`)
    continue
  }
  const found = Bun.which(harness.command)
  if (!found) {
    console.log(`  · ${harness.id.padEnd(12)} ${harness.command} not on PATH`)
    continue
  }
  const models = await catalog.models(harness)
  const detail = [
    `${models.length} model${models.length === 1 ? '' : 's'}${harness.modelsCommand ? ' (discovered)' : ''}`,
    harness.efforts.length ? `efforts: ${harness.efforts.join('/')}` : 'no efforts',
  ].join(', ')
  console.log(`  ✓ ${harness.id.padEnd(12)} ${detail}`)
  if (harness.modelsCommand && models.length <= 5)
    console.log(`      ↳ only found: ${models.join(', ') || '(none)'} — check models_parse for this harness`)
}
console.log('')

export type { HarnessDef }
