import { expect, test, describe } from 'bun:test'
import { readFile } from 'node:fs/promises'
import { BUILTINS, mergeHarnesses, resolveEffort, resolveModel, type HarnessDef } from './config'
import { extract, jsonLines, pick, pickText } from './extract'
import { flatten, renderArgs, run, HarnessError } from './run'
import { Catalog, parseJson, parseLines, parseRegex } from './catalog'
import { inspectEligibility } from '../src/leaderboard-protocol'
import { DEFAULTS } from '../src/settings'

const byId = new Map(BUILTINS.map((h) => [h.id, h]))

const harness = (patch: Partial<HarnessDef>): HarnessDef => ({
  id: 'test',
  command: 'true',
  args: [],
  timeoutMs: 5000,
  models: [],
  modelsParse: 'lines',
  modelOverrides: {},
  efforts: [],
  effortOff: null,
  effortMap: {},
  outfile: false,
  extract: { mode: 'text' },
  enabled: true,
  ...patch,
})

describe('model resolution', () => {
  test('splits on the first slash only, so provider/model survives', () => {
    const hit = resolveModel(byId, 'pi/anthropic/claude-opus-5')
    expect(hit?.harness.id).toBe('pi')
    expect(hit?.model).toBe('anthropic/claude-opus-5')
  })

  test('a bare harness id falls back to its default model', () => {
    expect(resolveModel(byId, 'claude-code')?.model).toBe('sonnet')
  })

  test('models are advisory: an unlisted id still resolves', () => {
    const hit = resolveModel(byId, 'claude-code/some-model-shipped-yesterday')
    expect(hit?.harness.id).toBe('claude-code')
    expect(hit?.model).toBe('some-model-shipped-yesterday')
  })

  test('an unknown harness is refused rather than guessed at', () => {
    expect(resolveModel(byId, 'nope/gpt-9')).toBeNull()
  })

  test('a disabled harness is refused', () => {
    const off = new Map([['x', harness({ id: 'x', enabled: false })]])
    expect(resolveModel(off, 'x/model')).toBeNull()
  })
})

describe('effort mapping', () => {
  const pi = byId.get('pi')!

  test('absent effort means the flag is dropped', () => {
    expect(resolveEffort(pi, undefined)).toBeNull()
  })

  test('the wire spelling for disabled reasoning becomes the CLI spelling', () => {
    // src/llm.ts sends `none` for the app's "off".
    expect(resolveEffort(pi, 'none')).toBe('off')
  })

  test('a harness that cannot disable reasoning drops the flag instead', () => {
    expect(resolveEffort(byId.get('claude-code')!, 'none')).toBeNull()
  })

  test('a rename table is applied when present', () => {
    expect(resolveEffort(harness({ effortMap: { xhigh: 'max' } }), 'xhigh')).toBe('max')
    expect(resolveEffort(harness({}), 'high')).toBe('high')
  })
})

describe('argument rendering', () => {
  test('a flag whose value does not apply is dropped as a pair', () => {
    const args = renderArgs(['-p', '--model', '{{model}}', '--thinking', '{{effort}}'], {
      model: 'opus',
      effort: null,
    })
    expect(args).toEqual(['-p', '--model', 'opus'])
  })

  test('an empty value counts as absent, so an empty model uses the CLI default', () => {
    expect(renderArgs(['-m', '{{model}}', '-q'], { model: '' })).toEqual(['-q'])
  })

  test('unknown placeholders are left alone rather than blanked', () => {
    expect(renderArgs(['{{unknown}}'], { model: 'x' })).toEqual(['{{unknown}}'])
  })

  test('the documented ssh pattern degrades to the command that was proven to work', () => {
    // harnesses.example.toml tells people to run a remote harness as
    //   ssh … host "hermes -z" "\"$(cat)\"" -m {{model}}
    // and promises that naming no model leaves exactly `hermes -z "$(cat)"`,
    // which is the invocation measured against Hermes v0.20.0. If argument
    // dropping ever changes, that promise is what breaks.
    const ssh = ['-T', '-o', 'BatchMode=yes', 'user@hostname', 'hermes -z', '"$(cat)"', '-m', '{{model}}']
    const remote = (model: string) => {
      const rendered = renderArgs(ssh, { model })
      return rendered.slice(rendered.indexOf('user@hostname') + 1).join(' ')
    }
    expect(remote('hermes-4-405b')).toBe('hermes -z "$(cat)" -m hermes-4-405b')
    expect(remote('')).toBe('hermes -z "$(cat)"')
  })

  test('every built-in renders without a stray placeholder', () => {
    for (const h of BUILTINS) {
      const args = renderArgs(h.args, {
        system: 'S',
        user: 'U',
        messages: 'M',
        model: 'm',
        effort: 'high',
        outfile: '/tmp/out',
      })
      expect(args.some((a) => a.includes('{{'))).toBe(false)
    }
  })
})

describe('message flattening', () => {
  test('separates the system message for harnesses that take one', () => {
    const { system, user } = flatten([
      { role: 'system', content: 'be a chess engine' },
      { role: 'user', content: 'FEN: ...' },
    ])
    expect(system).toBe('be a chess engine')
    expect(user).toBe('FEN: ...')
  })

  test('a retry exchange survives the flattening', () => {
    // The app appends the rejected reply and a correction; a one-shot CLI takes
    // one string, so the roles have to be spelled out to stay legible.
    const { all } = flatten([
      { role: 'system', content: 'sys' },
      { role: 'user', content: 'move?' },
      { role: 'assistant', content: '{"move":"Ke9"}' },
      { role: 'user', content: 'illegal, try again' },
    ])
    expect(all).toContain('sys')
    expect(all).toContain('[assistant]')
    expect(all).toContain('illegal, try again')
  })

  test('a lone user message is not decorated with a role header', () => {
    expect(flatten([{ role: 'user', content: 'hi' }]).user).toBe('hi')
  })
})

describe('extraction', () => {
  test('text mode takes stdout whole', () => {
    expect(extract({ mode: 'text' }, ' {"move":"e4"} ').text).toBe(' {"move":"e4"} ')
  })

  test('json mode reads a path and ignores a banner around the object', () => {
    const stdout = 'Booting…\n{"result":"{\\"move\\":\\"e4\\"}","usage":{"input_tokens":11,"output_tokens":4},"total_cost_usd":0.5}\ndone'
    const got = extract(
      { mode: 'json', text: 'result', input: 'usage.input_tokens', output: 'usage.output_tokens', cost: 'total_cost_usd' },
      stdout,
    )
    expect(got.text).toBe('{"move":"e4"}')
    expect(got.input).toBe(11)
    expect(got.cost).toBe(0.5)
  })

  test('jsonl-last takes the final matching event and skips noise', () => {
    const stdout = [
      '{"type":"session"}',
      'not json at all',
      '{"type":"message_end","message":{"content":[{"type":"text","text":"first"}]}}',
      '{"type":"tool_execution_end"}',
      '{"type":"message_end","message":{"content":[{"type":"thinking","text":"hmm"},{"type":"text","text":"second"}],"usage":{"input":7,"output":2,"cost":{"total":0.25}}}}',
    ].join('\n')
    const got = extract(
      {
        mode: 'jsonl-last',
        select: 'message_end',
        text: 'message.content',
        input: 'message.usage.input',
        output: 'message.usage.output',
        cost: 'message.usage.cost.total',
      },
      stdout,
    )
    // Thinking blocks are dropped: a reasoning trace is working, not an answer.
    expect(got.text).toBe('second')
    expect(got.input).toBe(7)
    expect(got.cost).toBe(0.25)
  })

  test('`where` picks the assistant event, not the prompt echoed back at us', () => {
    // pi emits message_end for the user message too. Without the filter the last
    // matching event can be the prompt, and the shim reports the position it was
    // given as if the model had said it.
    const stdout = [
      '{"type":"message_end","message":{"role":"user","content":[{"type":"text","text":"FEN: ..."}]}}',
      '{"type":"message_end","message":{"role":"assistant","content":[{"type":"text","text":"{\\"move\\":\\"Nc6\\"}"}]}}',
      '{"type":"message_end","message":{"role":"toolResult","content":[{"type":"text","text":"ls output"}]}}',
    ].join('\n')
    const spec = {
      mode: 'jsonl-last' as const,
      select: 'message_end',
      where: { 'message.role': 'assistant' },
      text: 'message.content',
    }
    expect(extract(spec, stdout).text).toBe('{"move":"Nc6"}')
    // Without it, the tool result wins — which is the bug the filter exists for.
    expect(extract({ ...spec, where: undefined }, stdout).text).toBe('ls output')
  })

  test("the harness's own error text is preferred over a slice of stdout", () => {
    const stdout =
      '{"type":"message_end","message":{"role":"assistant","content":[],"errorMessage":"400 The requested model is not supported."}}'
    const got = extract(
      {
        mode: 'jsonl-last',
        select: 'message_end',
        where: { 'message.role': 'assistant' },
        text: 'message.content',
        error: 'message.errorMessage',
      },
      stdout,
    )
    expect(got.text).toBe('')
    expect(got.error).toBe('400 The requested model is not supported.')
  })

  test('a usage figure can be the sum of several paths', () => {
    // Claude Code splits prompt tokens across three fields; reading only the
    // first reported 10 where the real figure was about 12,000.
    const stdout = JSON.stringify({
      result: 'e4',
      usage: { input_tokens: 10, cache_creation_input_tokens: 3895, cache_read_input_tokens: 8056 },
    })
    const got = extract(
      {
        mode: 'json',
        text: 'result',
        input: ['usage.input_tokens', 'usage.cache_creation_input_tokens', 'usage.cache_read_input_tokens'],
      },
      stdout,
    )
    expect(got.input).toBe(11961)
  })

  test('a missing usage path costs a counter, not the reply', () => {
    const got = extract({ mode: 'json', text: 'result', cost: 'nope.nothing' }, '{"result":"e4"}')
    expect(got.text).toBe('e4')
    expect(got.cost).toBe(0)
  })

  test('an outfile overrides whatever stdout said', () => {
    expect(extract({ mode: 'json', text: 'result' }, '{"result":"stdout"}', 'from file').text).toBe('from file')
  })

  test('helpers cope with absent paths', () => {
    expect(pick({ a: 1 }, undefined)).toBeUndefined()
    expect(pick(null, 'a.b')).toBeUndefined()
    expect(pickText({ a: 'x' }, 'a')).toBe('x')
    expect(pickText({}, 'a')).toBe('')
    expect(jsonLines('garbage')).toEqual([])
  })
})

describe('catalog parsing', () => {
  test('lines mode keeps id-shaped first tokens and drops prose', () => {
    const models = parseLines('Available models:\n  anthropic/claude-opus-5   $15/$75\n  openai/gpt-5.6-luna\n\nRun pi --help for more')
    expect(models).toContain('anthropic/claude-opus-5')
    expect(models).toContain('openai/gpt-5.6-luna')
    expect(models).not.toContain('Available')
    expect(models).not.toContain('Run')
  })

  test('regex mode rebuilds an id from columns, header skipped', () => {
    // The shape `pi --list-models` actually prints: provider and model in
    // separate columns, and the id it wants back is the two joined.
    const stdout = [
      'provider        model                     context',
      'github-copilot  claude-haiku-4.5          144K',
      'google          gemini-3-pro-preview      1M',
      '',
    ].join('\n')
    expect(parseRegex(stdout, '^(\\S+)\\s+(\\S+)', '$1/$2', 1)).toEqual([
      'github-copilot/claude-haiku-4.5',
      'google/gemini-3-pro-preview',
    ])
  })

  test('a malformed pattern yields nothing rather than throwing', () => {
    expect(parseRegex('anything', '([unclosed', '$1', 0)).toEqual([])
  })

  test('json mode reads strings or objects with an id', () => {
    expect(parseJson('{"data":[{"id":"a"},"b"]}', 'data')).toEqual(['a', 'b'])
    expect(parseJson('not json', 'data')).toEqual([])
  })

  test('discovery is unioned with the configured list, not replaced by it', async () => {
    const h = harness({
      id: 'disco',
      models: ['handwritten'],
      modelsCommand: ['printf', 'discovered\\n'],
    })
    const models = await new Catalog([h]).models(h)
    expect(models).toEqual(['handwritten', 'discovered'])
  })

  test('a failing discovery command falls back to the configured list', async () => {
    const h = harness({ id: 'broken', models: ['fallback'], modelsCommand: ['definitely-not-a-binary-xyz'] })
    expect(await new Catalog([h]).models(h)).toEqual(['fallback'])
  })

  test('discovery is cached, so opening settings twice spawns once', async () => {
    // `date +%N`-style uniqueness without depending on the shell: each run of
    // this prints a different value, so a second identical answer proves a cache.
    const h = harness({ id: 'cached', modelsCommand: ['bun', '-e', 'console.log(crypto.randomUUID())'] })
    const catalog = new Catalog([h])
    const first = await catalog.models(h)
    expect(await catalog.models(h)).toEqual(first)
  })

  test('rows carry the harness efforts, which is what drives the effort dropdown', async () => {
    const rows = await new Catalog([
      harness({ id: 'r', defaultModel: 'd', models: ['a'], efforts: ['low', 'high'], effortOff: 'off' }),
    ]).list()
    expect(rows.map((r) => r.id)).toEqual(['r', 'r/a'])
    expect(rows[1].reasoning).toEqual({ supported_efforts: ['low', 'high'], mandatory: false })
  })

  test('a per-model override beats the harness-wide list', async () => {
    const rows = await new Catalog([
      harness({ id: 'r', models: ['plain', 'quiet'], efforts: ['low'], modelOverrides: { quiet: { efforts: [] } } }),
    ]).list()
    expect(rows.find((r) => r.id === 'r/plain')?.reasoning).not.toBeNull()
    expect(rows.find((r) => r.id === 'r/quiet')?.reasoning).toBeNull()
  })
})

describe('config merging', () => {
  test('a patch overrides one field and keeps the rest of the built-in', () => {
    const merged = mergeHarnesses(BUILTINS, [{ id: 'pi', timeout_ms: 60_000 }])
    const pi = merged.find((h) => h.id === 'pi')!
    expect(pi.timeoutMs).toBe(60_000)
    expect(pi.command).toBe('pi')
    expect(pi.efforts).toContain('xhigh')
  })

  test('a partial extract patch keeps the paths it did not mention', () => {
    const merged = mergeHarnesses(BUILTINS, [{ id: 'pi', extract: { cost: 'other.path' } }])
    const pi = merged.find((h) => h.id === 'pi')!
    expect(pi.extract.cost).toBe('other.path')
    expect(pi.extract.text).toBe('message.content')
    expect(pi.extract.mode).toBe('jsonl-last')
  })

  test('a new harness needs a command and args; a fragment is ignored', () => {
    const merged = mergeHarnesses(BUILTINS, [
      { id: 'mine', command: 'foo', args: ['-p'] },
      { id: 'broken' },
    ])
    expect(merged.find((h) => h.id === 'mine')?.timeoutMs).toBe(300_000)
    expect(merged.find((h) => h.id === 'broken')).toBeUndefined()
  })

  test('a harness can be switched off without deleting its block', () => {
    const merged = mergeHarnesses(BUILTINS, [{ id: 'hermes', enabled: false }])
    expect(merged.find((h) => h.id === 'hermes')?.enabled).toBe(false)
  })
})

describe('harness matches stay out of the standings', () => {
  // The property this whole server depends on. Enforced in src/ and again in the
  // Worker; asserted here so a change to either is caught from this side too.
  const settings = { ...structuredClone(DEFAULTS), baseUrl: 'http://127.0.0.1:8199/v1' }

  test('a harness base URL is an exhibition, whatever else is set', () => {
    const { eligible, issues } = inspectEligibility(settings)
    expect(eligible).toBe(false)
    expect(issues.some((i) => i.field === 'baseUrl')).toBe(true)
  })

  test('and so is a LAN one', () => {
    expect(inspectEligibility({ ...settings, baseUrl: 'https://192.168.1.42:8199/v1' }).eligible).toBe(false)
  })
})

describe('running a process', () => {
  const root = import.meta.dir

  test('text mode round-trips stdin to stdout', async () => {
    const got = await run({
      harness: harness({ command: 'cat', stdin: '{{messages}}' }),
      model: '',
      messages: [{ role: 'user', content: 'e4 e5' }],
      root,
    })
    expect(got.text.trim()).toBe('e4 e5')
  })

  test('a json harness yields text and usage together', async () => {
    const got = await run({
      harness: harness({
        command: 'bun',
        args: ['-e', 'console.log(JSON.stringify({result:"{\\"move\\":\\"e4\\"}",usage:{input_tokens:9}}))'],
        extract: { mode: 'json', text: 'result', input: 'usage.input_tokens' },
      }),
      model: '',
      messages: [{ role: 'user', content: 'x' }],
      root,
    })
    expect(got.text).toBe('{"move":"e4"}')
    expect(got.input).toBe(9)
  })

  test('an outfile harness reads its reply from the file it was given', async () => {
    const got = await run({
      harness: harness({
        command: 'sh',
        args: ['-c', 'printf Nf3 > "$1"; echo chatter', 'harness', '{{outfile}}'],
        outfile: true,
      }),
      model: '',
      messages: [{ role: 'user', content: 'x' }],
      root,
    })
    expect(got.text).toBe('Nf3')
  })

  test('the outfile is cleaned up afterwards', async () => {
    let path = ''
    await run({
      harness: harness({
        command: 'sh',
        args: ['-c', 'printf %s "$1" > "$1"', 'harness', '{{outfile}}'],
        outfile: true,
      }),
      model: '',
      messages: [{ role: 'user', content: 'x' }],
      root,
    }).then((r) => (path = r.text))
    expect(path).toContain('grand-tensor-')
    expect(await readFile(path, 'utf8').then(() => 'still there', () => 'gone')).toBe('gone')
  })

  test('a missing binary fails as a client error, not a retryable one', async () => {
    // 5xx is ridden out forever at the default connection-retry setting, and a
    // binary that is not installed will not install itself.
    const err = await run({
      harness: harness({ command: 'definitely-not-a-binary-xyz' }),
      model: '',
      messages: [{ role: 'user', content: 'x' }],
      root,
    }).catch((e) => e)
    expect(err).toBeInstanceOf(HarnessError)
    expect((err as HarnessError).status).toBe(400)
  })

  test('a silent harness is an error rather than an empty move', async () => {
    const err = await run({
      harness: harness({ command: 'bun', args: ['-e', 'console.error("boom"); process.exit(3)'] }),
      model: '',
      messages: [{ role: 'user', content: 'x' }],
      root,
    }).catch((e) => e)
    expect((err as Error).message).toContain('boom')
  })

  test('a warning printed after the answer does not lose the answer', async () => {
    const got = await run({
      harness: harness({ command: 'bun', args: ['-e', 'console.log("e4"); console.error("deprecated"); process.exit(1)'] }),
      model: '',
      messages: [{ role: 'user', content: 'x' }],
      root,
    })
    expect(got.text.trim()).toBe('e4')
  })

  test('an overrunning harness is killed and reported as a timeout', async () => {
    const err = await run({
      harness: harness({ command: 'sleep', args: ['30'], timeoutMs: 250 }),
      model: '',
      messages: [{ role: 'user', content: 'x' }],
      root,
    }).catch((e) => e)
    expect((err as HarnessError).status).toBe(504)
    expect((err as Error).message).toContain('timed out')
  })

  test('an aborted request kills the process', async () => {
    const controller = new AbortController()
    const started = performance.now()
    const pending = run({
      harness: harness({ command: 'sleep', args: ['30'], timeoutMs: 30_000 }),
      model: '',
      messages: [{ role: 'user', content: 'x' }],
      signal: controller.signal,
      root,
    }).catch((e) => e)
    setTimeout(() => controller.abort(), 100)
    await pending
    expect(performance.now() - started).toBeLessThan(5000)
  })
})
