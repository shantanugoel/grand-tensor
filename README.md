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
| Reasoning effort | `default` sends nothing; otherwise `reasoning.effort` (OpenRouter) or `reasoning_effort` (OpenAI) |
| Games in series | Colors alternate every game; 1 / 0.5 / 0 scoring decides the champion |
| Ply limit | Games past this are adjudicated a draw so a series can't hang |
| Retries before forfeit | Illegal or unparseable moves are re-prompted this many times, then the model loses the game |

Set a model id to `random` to run a local demo match with no API key at all.

## Build & deploy

```bash
bun run build
```

`dist/` is a self-contained static bundle with relative asset paths — drop it on Netlify, Vercel,
GitHub Pages, S3, or anything that serves files.

## How it works

| File | Job |
| --- | --- |
| [src/series.ts](src/series.ts) | Runs the series: alternates colors, calls the models, applies moves, keeps the score. Knows nothing about the DOM or three.js |
| [src/llm.ts](src/llm.ts) | One `fetch` to `/chat/completions`, plus token/cost accounting |
| [src/prompt.ts](src/prompt.ts) | Builds the position prompt and forgivingly parses a legal SAN out of whatever comes back |
| [src/three/voxels.ts](src/three/voxels.ts) | Pieces authored as 7-wide side profiles, revolved or extruded into cubes and merged into one geometry per type |
| [src/three/arena.ts](src/three/arena.ts) | Board, lights, bloom, camera framing, and the move choreography |
| [src/three/fx.ts](src/three/fx.ts) | Debris, shockwave rings, floating pixel text, screen shake |
| [src/ui/](src/ui/) | The HUD overlay and the settings modal |

Cost is shown per model as well as for the series. OpenRouter reports the exact spend on every
response and that is used verbatim; for any other endpoint the series reads list pricing from
`/models` once at the start and derives the cost from the token counts. Endpoints that publish no
pricing simply show `—`.

Each model is asked for JSON — `{"move": "Nf3", "say": "..."}` — with the full legal move list in
the prompt. Anything that isn't a legal move is re-prompted with the error; run out of retries and
the model forfeits the game. Illegal-move counts are tracked per model and shown in the HUD, since
that is real signal about a model, not just noise.

The board is rebuilt from the authoritative `chess.js` position after every move, so castling,
en passant and promotion stay correct without needing bespoke animations.

## Controls

- **Turn speed** — `Turbo` runs as fast as the API answers (effects are suppressed so they don't
  pile up), through to `Cinematic` at four seconds a move.
- **Pause / Resume** — stops between moves; the in-flight request still completes.
- **Orbit** — slow auto-rotate. You can always drag to orbit and scroll to zoom.
