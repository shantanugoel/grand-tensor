# Move-quality eval

Grades a model's moves against Stockfish and reports **centipawn loss** (CPL) —
how much worse than best each move was. This exists because win/loss over a
four-game series says almost nothing at that sample size, and "the models look
bad" is not a number you can optimise against.

## Setup

```bash
brew install stockfish
```

Put a key in `.env` (Bun loads it automatically):

```
GRAND_TENSOR_API_KEY=sk-or-...
GRAND_TENSOR_BASE_URL=https://openrouter.ai/api/v1
```

## Running

```bash
bun run eval --models "openai/gpt-5.6-luna" --limit 40
```

Comparing two prompts on the same positions:

```bash
bun run eval --models "openai/gpt-5.6-luna" --variants baseline,scaffolded --limit 60
```

### Options

| Flag | Default | Meaning |
| --- | --- | --- |
| `--models` | — | Comma-separated model ids (required) |
| `--variants` | `baseline` | Prompt variants from `src/eval/variants.ts` |
| `--limit` | all | Positions to use — the main cost dial |
| `--depth` | `12` | Engine depth for grading |
| `--concurrency` | `4` | Model calls in flight |
| `--temperature` | `0` | Kept at 0 so reruns are comparable |
| `--effort` | `default` | Reasoning effort. See the warning below |
| `--positions` | `eval/positions.json` | Position set |
| `--json` | — | Write per-move detail to a file |

## Reading the output

```
  baseline      n=  40  mean=  180.2  median= 120.0  p90=  455.0  blunder= 22.5%  best= 18.0%  illegal=0  trunc=0
  scaffolded    n=  40  mean=  120.7  median=  84.0  p90=  310.0  blunder= 12.5%  best= 27.5%  illegal=0  trunc=0
    baseline -> scaffolded: 59.5 cp (95% CI 21.0 to 98.4, paired n=40) — BETTER
```

- **mean/median CPL** — lower is better. CPL is heavily right-skewed, so the
  median says more about typical play and the mean is dominated by the disasters.
- **p90 / blunder rate** — the tail, which is what actually loses games.
- **best** — share of moves matching the engine's first choice.
- **illegal / trunc** — replies that named no legal move, or ran out of budget.
  These are harness metrics, not chess ones, and are counted separately.
- **harness-errors** — our faults (network, engine). Never blamed on the model.

The last line is the only one worth drawing a conclusion from. It is a **paired**
bootstrap over positions both arms played, so position difficulty cancels out.
If the interval spans zero it says `no significant difference`, and that is the
honest reading no matter how good the means look.

## Pin the effort before comparing two models

`--effort default` sends no reasoning parameter at all, so **each provider applies
its own default, and those differ by model**: `gpt-5.6-luna` defaults to `medium`,
`deepseek-v4-flash-0731` to `high`. Left alone, a two-model run compares two
different amounts of thinking and reports the difference as if it were skill.

Pass `--effort low` (or whatever both models support) for a like-for-like number.
Note the supported sets differ too — DeepSeek V4 Flash offers `max/high/low` with
no `medium`, so an exact match with Luna is not always available. When it isn't,
run each effort separately rather than pretending one number covers both.

Effort also drives truncation: OpenRouter allots roughly 80% of `max_tokens` to
reasoning at high effort, so a 16k cap leaves ~3k for the answer. A model that
reasons past that emits no move, which is a budget failure rather than a chess
one — `trunc` in the report, not `illegal`.

## Why these choices

**One attempt per position, no retries.** Retries are a property of the arena,
not of move quality. Allowing them here would let a model launder a bad first
answer into a good score.

**Fixed positions, not played games.** Two prompt variants playing each other
diverge after the first differing move and end up graded on different positions,
so most of the measured difference is *which positions each happened to visit*.
Holding positions constant makes the comparison paired, which is both unbiased
and far tighter for the same spend.

**`searchmoves`, not analyse-the-resulting-position.** The played move is scored
at the same node and depth as the best move. Evaluating the position *after* the
move searches one ply deeper and off by a tempo, which biases every result.

**The engine is serialised.** One process, one stdio pipe, no request ids —
overlapping searches steal each other's output and return confident wrong scores.
Model calls still run concurrently; only the engine goes one at a time.

## The position set

`eval/positions.json` is committed on purpose: a shared, fixed benchmark is what
makes two runs comparable. 228 positions from seeded self-play with randomised
openings, filtered to drop already-decided positions (|eval| > 900), balanced
114 White / 114 Black to move across opening, middlegame and endgame.

Better input is your own match PGNs, since those are the positions your models
actually reach — `fromPgn()` in `src/eval/positions.ts` builds a set from them.

## Adding a prompt variant

Add it to `src/eval/variants.ts` and pass its name to `--variants`. `baseline`
builds its messages from the same `systemPrompt`/`movePrompt` the arena uses, so
it stays honest as production changes.
