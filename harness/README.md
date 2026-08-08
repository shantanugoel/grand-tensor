# Harness mode

Play Grand Tensor against local agent CLIs — Claude Code, Codex, Gemini, Amp, pi,
Prime Agent, Hermes — instead of a hosted model.

```bash
bun run harness
```

Paste the base URL it prints into **Settings → Endpoint**. That's the whole setup.

## How it works

The app talks to exactly one thing: `POST {baseUrl}/chat/completions`, with an
optional `GET {baseUrl}/models` for the catalog. This server speaks both and
answers by running a CLI, so nothing in `src/` knows it exists — there is no
harness branch in the game, no second transport, no forked prompt.

**Matches played this way are exhibitions and cannot be submitted.** Ranked play
pins the base URL to OpenRouter, enforced independently by the client
([src/leaderboard-protocol.ts](../src/leaderboard-protocol.ts)) and the Worker
([worker/validation.ts](../worker/validation.ts)). There is no path from here to
the standings, and nothing here can create one.

## Choosing a harness and model

The **Model id** field selects both, split on the first slash:

| You type | Runs |
|---|---|
| `claude-code/opus` | `claude --model opus` |
| `pi/google/gemini-3-pro` | `pi --model google/gemini-3-pro` |
| `amp/deep` | `amp -m deep` (amp's axis is its agent mode) |
| `claude-code` | the harness's `default_model` |

Autocomplete comes from `/models`, and the **Reasoning effort** dropdown fills
itself from the same response — so on a harness that exposes reasoning levels
(pi, Prime Agent) the dropdown becomes a real control rather than decoration.

Listed models are **advisory, not a whitelist**. Anything after the harness id is
passed through, so a model released after this was written works without touching
any config. The list only decides what autocompletes.

A CLI that wants the provider as a *separate flag* — hermes takes
`-m <name> --provider <id>` — can split the field further with `model_pattern`,
a regex whose named groups become placeholders. One entry then covers every
provider: `hermes/portal/deepseek-v4-flash` and
`hermes/openrouter/deepseek-v4-flash` differ only in a flag. See
[harnesses.example.toml](harnesses.example.toml).

## The seven

| id | binary | effort axis | usage reported |
|---|---|---|---|
| `claude-code` | `claude` | `--effort` low→max | tokens + real USD cost |
| `codex` | `codex` | — | — |
| `gemini` | `gemini` | — | — |
| `amp` | `amp` | — (mode *is* the model) | — |
| `pi` | `pi` | `--thinking` off→xhigh, discovered models | tokens + cost |
| `prime-agent` | `prime-agent` | `--thinking` | tokens + cost |
| `hermes` | `hermes` | — | — |

Where the effort column is `—`, the CLI has no such flag and the **Reasoning
effort** dropdown correctly locks to `default`. That is the harness having one
setting, not the dropdown being broken. Codex may accept
`-c model_reasoning_effort=…`; it took a deliberately invalid value without
complaint when tested, so it is left out rather than guessed at — add it in your
own config if you can confirm it.

A harness whose binary isn't on `PATH` is listed with a `·` at startup and simply
never selected. Where usage isn't reported the HUD shows `$0.00` — that means
"not measured", not "free".

Verified against the installed CLIs: `claude`, `codex`, `gemini`, `amp`, `pi`,
and `hermes` (v0.20.0, over ssh). `prime-agent` is configured from its published
docs; check its flags against your build before trusting them.

Hermes uses `-z`, its programmatic entry point, rather than the `chat -q` the
docs steer you towards — `chat` given a piped prompt ignored it, printed a 6 KB
banner and exited 0 having answered nothing.

To run a harness on another machine over ssh, see the worked block in
[harnesses.example.toml](harnesses.example.toml).

## Configuration

Copy [harnesses.example.toml](harnesses.example.toml) to `harnesses.toml` (loaded
automatically) or pass `--config`. Blocks merge over the built-ins by `id`, so
changing one field doesn't mean restating the rest, and a new agent is a new
block rather than a code change. JSON works too.

## Options

| flag | default | |
|---|---|---|
| `--port` | `8199` | |
| `--host` | `127.0.0.1` | binding anything else requires `--token` |
| `--token` | — | paste it into the app's **API key** field |
| `--config` | `harnesses.toml` | TOML or JSON |
| `--models-ttl` | `300` | seconds to cache discovered model lists |
| `--cert` / `--key` | — | serve HTTPS, for the LAN case below |

## Playing over a LAN

`http://localhost` is a trustworthy origin, so the deployed HTTPS site can reach
it in Chrome and Firefox; Safari is stricter. A **LAN IP over plain HTTP is
blocked as mixed content in every browser**, so pick one of:

- run the game locally too (`bun run dev`) — http to http, nothing to configure;
- give the server a certificate and use `https://`:

  ```bash
  mkcert 192.168.1.42
  bun run harness --host 0.0.0.0 --token secret \
    --cert ./192.168.1.42.pem --key ./192.168.1.42-key.pem
  ```

Preflights already answer Chrome's private-network check.

## Two things to know before a long match

**These are agents, not models.** Each definition pins `cwd` to `harness/sandbox`
and passes the flags that stop the CLI reading `AGENTS.md`/`CLAUDE.md`, loading
MCP servers, or using tools. Keep that if you edit a block — otherwise a chess
move inherits whatever repo it started in.

**Speed and cost.** A move takes tens of seconds; `claude-code/haiku` measured
~45s and about $0.05 for a single opening reply. A 200-ply game is hours and
real money. Lower **Ply limit** for exhibitions.

The server runs local binaries on text arriving over HTTP. On loopback that's you
talking to yourself; it refuses to bind anything else without `--token`.
