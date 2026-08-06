# Grand Tensor

**The machine grandmaster circuit.** Two language models play a series of chess games at each
other in a voxel battle arena, and you watch the whole thing — moves, captures, token burn and
score — in real time in the browser.

It is a single static site. No backend: your browser talks straight to whatever
OpenAI-compatible endpoint you configure, and the API key never leaves `localStorage`.

## Run it

```bash
bun install
bun run dev
```

Then open the printed URL, hit **⚙ Settings**, and fill in:

| Field | Notes |
| --- | --- |
| Base URL | Any OpenAI-compatible `/chat/completions` host. Default: `https://openrouter.ai/api/v1` |
| API key | Stored in this browser only, sent only to the base URL above |
| Model id | e.g. `deepseek/deepseek-v4-flash-0731`, `openai/gpt-5.6-luna`. The field autocompletes from the endpoint's `/models` |
| Reasoning effort | Only the levels the chosen model actually accepts — read from its `/models` entry, so `deepseek-v4-flash-0731` offers max/high/low with no medium while `gpt-5.6-luna` adds xhigh and none. `default` sends nothing and lets the provider choose (the dropdown names which level that is). Sent as `reasoning.effort` on OpenRouter, `reasoning_effort` elsewhere |
| Games in series | Colors alternate every game; 1 / 0.5 / 0 scoring decides the champion |
| Ply limit | Games past this are adjudicated a draw so a series can't hang |
| Retries before forfeit | Illegal or unparseable moves are re-prompted this many times, then the model loses the game |
| Connection retry cap | Network and provider failures are retried on their own budget, backing off 2s → 60s, and never count as illegal moves. `0` (the default) keeps retrying; anything else parks the series after that many tries. Either way it stops on the failed move rather than throwing the series away — **Retry** sends it again |
| Previous games | On by default. Sends every completed game's moves, result and ending reason to both models so they can adapt during a series |
| Position prompt template | Customize the per-move prompt with variables such as `{{fen}}`, `{{moves}}`, `{{legalMoves}}`, `{{player}}`, and `{{previousGames}}`. The required JSON response rules stay in a separate system message |

Set a model id to `random` to run a local demo match with no API key at all.

## Sharing a result

When a series finishes, the panel offers **Result**, **Link**, **𝕏 Post** and — where the browser
supports it — a native **Share** sheet.

*Result* copies a Wordle-style summary: score, one coloured square per game, total moves, tokens,
spend and each model's illegal-move count. *Link* copies a URL whose fragment carries the matchup
(`#a=…&b=…&ae=high&g=6`) — opening it restores those models, efforts and series length and then
asks the visitor for their own key. Keys are never put in the link.

## Community leaderboard

The **♜ Standings** button opens the rolling 30-day community leaderboard. A finished match gets
an optional **♜ Submit** button only when it used a ranked configuration: OpenRouter, 2–10 games
with alternating colors, the stock prompt, temperature 0.2, a 200-ply limit per game, three
retries, previous-game context, and commentary. Custom matches and local `random` demos remain
exhibitions and never affect standings. The Settings modal marks each field with what its current
value does to eligibility, so it is always visible which circuit a match would submit to.

Ranked play is split into **circuits** by completion budget — 16,000 tokens per move (Standard) and
32,000 (Extended). On OpenRouter the reasoning budget is a fraction of `max_tokens`, so a bigger cap
buys more thinking; mixing caps in one table would rank budgets rather than models.

An entrant is a **model at an effort level**, not a model. One model at `low` and at `xhigh` are
different competitors and appear as separate rows; `default` — no effort parameter sent — is its own
entrant too.

Standings are ordered by a **Bradley-Terry** rating fit over every result in the window, anchored so
the field averages 1500. Beating a strong entrant counts for more than beating a weak one, so
grinding a weak opponent pulls a rating toward theirs rather than toward 100%. Any single pairing
contributes at most 40 games to the fit, and entrants with fewer than three distinct opponents — or
whose results never connect to the main field — are listed but not ranked. Ratings are re-derived
from the stored submissions on every read, never stored, so the method can change without migrating
anything. Clicking a row opens that entrant's record: who they actually played, and how often.

Submitting uploads exact model ids, the standard configuration, results, and PGNs. It never uploads
the API key, player labels, prompt text, commentary, usage, latency, or cost. The Worker replays
every PGN and derives the scores itself. Since model calls still happen directly from the browser,
model identity is explicitly described as community-reported rather than cryptographically
verified.

The backend lives in `worker/` and is deployed separately to
`leaderboard.grandtensor.shantanugoel.com`:

```bash
bun run leaderboard:migrate:local   # local D1, once per new migration
bun run leaderboard:dev
bun run leaderboard:migrate:remote  # production D1
bun run leaderboard:deploy
```

Wrangler is pinned as a development dependency. Production values for `TURNSTILE_SECRET`,
`RUN_TICKET_SECRET`, and `ABUSE_HASH_SECRET` belong in Cloudflare Worker secret storage, never in
the repository. Local values live in the ignored `.dev.vars` file; Wrangler state is ignored too.

## Build & deploy

```bash
bun run build
```

`dist/` is a self-contained static bundle with relative asset paths — drop it on Netlify, Vercel,
GitHub Pages, S3, or anything that serves files. To check it before you deploy:

```bash
bun run preview
```

Bun does the bundling itself from the HTML entrypoint, so there is no bundler config to keep in
sync — `bun run dev` serves the same graph with hot reloading, and `bun run build` writes it out.

## How it works

| File | Job |
| --- | --- |
| [src/series.ts](src/series.ts) | Runs the series: alternates colors, calls the models, applies moves, keeps the score. Knows nothing about the DOM or three.js |
| [src/llm.ts](src/llm.ts) | One `fetch` to `/chat/completions`, plus token/cost accounting |
| [src/prompt.ts](src/prompt.ts) | Builds the position prompt and forgivingly parses a legal SAN out of whatever comes back |
| [src/three/voxels.ts](src/three/voxels.ts) | Pieces authored as 7-wide side profiles, revolved or extruded into cubes and merged into one geometry per type |
| [src/three/arena.ts](src/three/arena.ts) | Board, lights, bloom, camera framing, and the move choreography |
| [src/three/fx.ts](src/three/fx.ts) | Debris, shockwave rings, floating pixel text, screen shake |
| [src/ui/](src/ui/) | The HUD overlay, the settings modal and the small-screen affordances |
| [src/share.ts](src/share.ts) | Result card text, and encoding/decoding a matchup link |
| [src/leaderboard.ts](src/leaderboard.ts) | Optional submission flow, Turnstile, and standings UI |
| [worker/](worker/) | Cloudflare Worker API, PGN validation, abuse controls, and D1 migrations |
| [dev.ts](dev.ts) / [preview.ts](preview.ts) | `Bun.serve` for development with HMR, and for serving the built `dist/` |

Models with no reasoning levels at all get a disabled dropdown that says so; a model the endpoint
doesn't list falls back to offering the full set. If a saved or shared setting names an effort the
model has since stopped accepting, the series drops to the provider default and says so in the log
rather than letting the request fail.

Cost is shown per model as well as for the series. OpenRouter reports the exact spend on every
response and that is used verbatim; for any other endpoint the series reads list pricing from
`/models` once at the start and derives the cost from the token counts. Endpoints that publish no
pricing simply show `—`.

Each model is asked for JSON — `{"move": "Nf3", "say": "..."}` — with the full legal move list in
the prompt. Anything that isn't a legal move is re-prompted with the error; run out of retries and
the model forfeits the game. Illegal-move counts are tracked per model and shown in the HUD, since
that is real signal about a model, not just noise.

By default, later games also receive the moves, result and ending reason from every completed game
in the series. This can be disabled in Settings. The position prompt itself is editable there and
supports the variables shown beside the editor; restoring defaults restores the built-in template.

The board is rebuilt from the authoritative `chess.js` position after every move, so castling,
en passant and promotion stay correct without needing bespoke animations.

## On a phone

Three layouts, picked by the viewport rather than by sniffing the device:

- **Desktop** — player cards and battle log in side rails.
- **Portrait phone** (≤ 640px wide) — cards sit in a row under the vitality bars and the battle log
  collapses to a one-line ticker above the dock; tap its header to slide it open into a sheet.
- **Landscape phone** (≤ 560px tall) — the rails come back, much narrower, so the board keeps the
  middle of the screen.

Portrait shows a one-time nudge toward landscape; tapping it goes fullscreen and locks the
orientation where the browser allows that (iOS Safari allows neither, so it just asks you to
rotate). The ⛶ button in the header does the same thing on demand.

Phones also render without the shadow pass, at a capped pixel ratio and with a cheaper bloom.

## Controls

- **Turn speed** — `Turbo` runs as fast as the API answers (effects are suppressed so they don't
  pile up), through to `Cinematic` at four seconds a move.
- **Pause / Resume** — stops between moves; the in-flight request still completes.
- **Orbit** — slow auto-rotate. You can always drag to orbit and scroll to zoom.
