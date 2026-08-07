/** Summary statistics, and the paired comparison that makes A/B testing honest.
 *
 *  Move quality is extremely noisy: a handful of positions dominate any small
 *  sample, and CPL is heavily right-skewed. Reporting a bare mean invites reading
 *  a 12-centipawn "improvement" as real when it is well inside the noise, so
 *  every comparison here comes with an interval attached. */

export type Summary = {
  n: number
  meanCpl: number
  medianCpl: number
  /** The tail is what a chess player actually feels, and the mean hides it. */
  p90Cpl: number
  blunderRate: number
  mistakeRate: number
  /** Share of moves matching the engine's first choice. */
  bestRate: number
}

const quantile = (sorted: number[], q: number): number => {
  if (!sorted.length) return 0
  const pos = (sorted.length - 1) * q
  const lo = Math.floor(pos)
  const hi = Math.ceil(pos)
  return lo === hi ? sorted[lo] : sorted[lo] + (sorted[hi] - sorted[lo]) * (pos - lo)
}

export const mean = (xs: number[]): number =>
  xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0

export function summarize(cpls: number[]): Summary {
  const sorted = [...cpls].sort((a, b) => a - b)
  const share = (pred: (c: number) => boolean) =>
    cpls.length ? cpls.filter(pred).length / cpls.length : 0
  return {
    n: cpls.length,
    meanCpl: mean(cpls),
    medianCpl: quantile(sorted, 0.5),
    p90Cpl: quantile(sorted, 0.9),
    blunderRate: share((c) => c >= 300),
    mistakeRate: share((c) => c >= 100 && c < 300),
    bestRate: share((c) => c < 10),
  }
}

export type Comparison = {
  n: number
  /** Mean of (baseline - variant): positive means the variant lost less. */
  meanDiff: number
  ci95: [number, number]
  /** Whether the interval excludes zero — the only claim worth making. */
  significant: boolean
}

/** Bootstrap CI over *paired* differences.
 *
 *  Pairing is what buys the power here. Position difficulty varies enormously and
 *  is common to both arms, so differencing within a position removes it entirely
 *  and leaves only the effect of the change being tested. An unpaired comparison
 *  on the same data needs several times the sample to see the same effect. */
export function comparePaired(
  baseline: Map<string, number>,
  variant: Map<string, number>,
  iterations = 10_000,
  seed = 42,
): Comparison {
  const diffs: number[] = []
  for (const [id, base] of baseline) {
    const other = variant.get(id)
    if (other !== undefined) diffs.push(base - other)
  }
  if (diffs.length < 2) return { n: diffs.length, meanDiff: mean(diffs), ci95: [0, 0], significant: false }

  // Seeded so a reported interval can be reproduced exactly.
  let a = seed >>> 0
  const rand = () => {
    a = (a + 0x6d2b79f5) >>> 0
    let t = Math.imul(a ^ (a >>> 15), 1 | a)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }

  const means: number[] = []
  for (let i = 0; i < iterations; i++) {
    let total = 0
    for (let j = 0; j < diffs.length; j++) total += diffs[Math.floor(rand() * diffs.length)]
    means.push(total / diffs.length)
  }
  means.sort((x, y) => x - y)
  const lo = quantile(means, 0.025)
  const hi = quantile(means, 0.975)
  return {
    n: diffs.length,
    meanDiff: mean(diffs),
    ci95: [lo, hi],
    significant: lo > 0 || hi < 0,
  }
}
