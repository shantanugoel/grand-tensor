# Measured results

Everything here is centipawn loss per move against Stockfish 18 at depth 12,
scored on the 228-position set in `positions.json`, paired within position. All
runs used `--limit 80` and `--temperature 0` unless noted.

Reproduce any row with the command beneath it. Numbers will move a little —
providers are not deterministic even at temperature 0 — but two identical runs
came out at 126.8 and 119.3 mean, so **treat anything under ~7.5 cp as noise.**

## Reference points

| | mean | median | blunder | engine-best |
| --- | --- | --- | --- | --- |
| Stockfish itself | 0 | 0 | 0% | 100% |
| **random legal move** | **299.1** | **210** | **40.0%** | **2.5%** |

The random row is measured on this position set, not estimated. It is the floor
any result should be read against.

## What the prompt change is worth

`legacy` is the pre-scaffolding prompt: bare SAN move list, JSON with `move`
first. `baseline` is what ships now: tactical brief, landing-square annotations,
and thinking fields before the move.

| model | legacy mean | baseline mean | paired Δ | 95% CI | |
| --- | --- | --- | --- | --- | --- |
| qwen3.5-9b *(reasoning off)* | 318.1 | 218.6 | **+97.2** | [31.2, 164.0] | significant |
| llama-3.1-8b | 265.0 | 189.1 | **+74.8** | [13.8, 138.2] | significant |
| deepseek-v4-flash *(reasoning off)* | 228.6 | 158.8 | **+68.8** | [15.1, 125.4] | significant |
| gpt-5.6-luna | 117.9 | 71.2 | **+46.7** | [14.4, 84.5] | significant |
| gemma-3-4b | 261.2 | 245.2 | +16.6 | [−67.5, 96.3] | inconclusive¹ |
| ministral-3b | 282.9 | 251.4 | +2.4 | [−49.4, 55.7] | no effect |

¹ 14 rate-limit failures survived retry and all landed in one arm, leaving 49
paired positions. Asymmetric missingness — do not read this row as a null.

```bash
bun run eval --models "meta-llama/llama-3.1-8b-instruct" --variants legacy,baseline --limit 80
```

**The effect grows as models get weaker, then collapses.** Strongest at 8–9B,
smaller for a frontier model that already does this bookkeeping correctly, and
absent at 3B. Ministral 3B plays at 3.9% engine-best against random's 2.5% —
there is no board understanding there to scaffold, and no prompt fixes that.

One caution at the bottom end: ministral's illegal-move rate went 3 → 11 with the
longer prompt while gemma's went 15 → 7. Not a clean pattern, but a plausible
crowding-out of instruction-following in models with little to spare.

## What reasoning effort is worth

Paired on 78 positions, all four arms on identical footing.

| arm | mean | median | blunder | engine-best | cost |
| --- | --- | --- | --- | --- | --- |
| baseline prompt @ medium, 16k | 117.9 | 41 | 12.8% | 35.9% | $0.12 |
| baseline prompt @ high, 32k | 111.8 | 42 | 12.8% | 35.9% | $1.09 |
| scaffolded @ medium, 16k | 71.2 | 43 | 3.8% | 33.3% | **$0.11** |
| scaffolded @ high, 32k | **56.9** | **30** | **2.6%** | **46.2%** | $1.09 |

| effect | Δ | 95% CI | |
| --- | --- | --- | --- |
| high effort alone | 6.1 | [−43.6, 57.4] | not significant |
| high effort, given scaffolding | 14.4 | [−3.6, 35.6] | not significant |
| scaffolding alone | 46.7 | [14.4, 84.5] | **significant** |
| both vs the old production config | 61.1 | [25.2, 101.7] | **significant** |

**Scaffolding survives; effort does not.** High effort costs 10x for an effect
whose interval straddles zero — and its blunder rate and best-move rate are
identical to medium's, to the decimal.

An earlier reading of this data claimed high effort raised best-move rate from
41% to 50%. That was measured on the subset high effort could answer at a 16k
cap, which is the easier positions. On the full set the effect vanishes.

## Why the cap moved to 128k

Truncation — a reply that spends its budget reasoning and returns no move at all.

| model / effort | 16k cap | 32k cap | 60k cap |
| --- | --- | --- | --- |
| gpt-5.6-luna @ medium | 0% | — | — |
| gpt-5.6-luna @ high | **30%** | 2.6% | — |
| gpt-5.6-luna @ max | — | — | wants 9k–50k per move |
| deepseek-v4-flash @ any effort | **80%** | — | — |
| deepseek-v4-flash @ max | — | — | **still truncates** |

81% of DeepSeek's bill at 16k bought replies containing nothing. A cap that low
does not rank chess; it ranks whose reasoning happens to fit.

## deepseek-v4-flash ignores every reasoning lever but one

One middlegame position, four request shapes:

| request | reasoning tokens | latency | move returned |
| --- | --- | --- | --- |
| `reasoning: {effort: "low"}` | 12,709 | 752s | none |
| `reasoning: {max_tokens: 2000}` | 12,520 | 443s | none |
| `reasoning_effort: "low"` (flat) | 12,396 | 254s | none |
| `reasoning: {enabled: false}` | **0** | **3s** | yes |

All three gradation levers land within 2.5% of each other. For this model
reasoning is binary, and `enabled: false` is the only setting it honours.

## Wall clock, which is the real constraint

Max effort is impractical regardless of budget:

- gpt-5.6-luna @ max: 83s, 199s, **426s** on three consecutive middlegame positions
- deepseek-v4-flash @ max: 337s, 687s, **2224s** (37 minutes for one move)

A 120-ply game at those rates runs to hours or days. The token cap was acting as
an accidental proxy for a time limit — badly, because it enforces time by cutting
a model off mid-sentence. A wall-clock rule would be the honest version, and
there is not one yet.

## Known gaps

- Every number is one position set from one seed. `fromPgn()` builds a set from
  your own match PGNs, which is the distribution that actually matters.
- `baseline` bundles four changes — thinking fields first, tactical brief,
  landing-square annotation, and the check/capture warning. Which one carries the
  effect is unmeasured.
- The scaffolding reliably cuts blunders and does **not** raise best-move rate
  (Luna 35.9% → 33.3%, unchanged within noise). It is a blunder filter, not a
  strength improvement.
- Move quality is not match outcome. None of this models retries or forfeits.
