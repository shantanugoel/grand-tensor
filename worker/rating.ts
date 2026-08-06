/** Bradley-Terry ratings for the community standings.
 *
 *  Raw score% ranks whoever picked the weakest opponents, because it treats
 *  every game as equally informative. Bradley-Terry instead asks: which vector
 *  of strengths best explains *all* the results at once? Beating a strong
 *  entrant moves you further than beating a weak one, and grinding a weak
 *  opponent pulls your rating toward theirs rather than toward 100%.
 *
 *  Nothing here is incremental. Ratings are re-derived from the whole window on
 *  every computation, so the algorithm can change without migrating a single
 *  stored number — the submissions are the record, the ratings are a view. */

import { entrantKey, type Entrant } from '../src/leaderboard-protocol'

/** One submitted series, from A's point of view. */
export type SeriesResult = {
  a: Entrant
  b: Entrant
  wins: number
  draws: number
  losses: number
}

export type RatedEntrant = {
  model: string
  effort: string
  rating: number
  ratingMargin: number
  provisional: boolean
  opponents: number
  games: number
  series: number
  wins: number
  draws: number
  losses: number
  points: number
  scorePct: number
}

/** Below this many distinct opponents a rating is an artifact of who you happened
 *  to play, so the entrant is listed but not ranked. */
export const MIN_OPPONENTS = 3

/** Games any single pairing may contribute to the fit. Beyond this the record is
 *  rescaled, preserving the observed score rate while capping how much one
 *  matchup can move a rating — the direct answer to grinding one weak opponent. */
export const PAIR_GAME_CAP = 40

/** Prior width in log-odds. Pulls sparse entrants toward the field average
 *  instead of letting a clean sweep run off to infinity. ~1.5 logits is roughly
 *  260 rating points, wide enough not to flatten real differences. */
const PRIOR_SIGMA = 1.5

/** Rating points per logit, the conventional Elo scale factor. */
const SCALE = 400 / Math.LN10
const ANCHOR = 1500
const MAX_ITERATIONS = 200
const CONVERGENCE = 1e-9

type Pairing = { i: number; j: number; scoreI: number; games: number }

type Totals = {
  entrant: Entrant
  games: number
  series: number
  wins: number
  draws: number
  losses: number
  opponents: Set<string>
}

function accumulate(totals: Map<string, Totals>, entrant: Entrant, opponent: Entrant, w: number, d: number, l: number) {
  const key = entrantKey(entrant)
  const row =
    totals.get(key) ??
    ({ entrant, games: 0, series: 0, wins: 0, draws: 0, losses: 0, opponents: new Set<string>() } satisfies Totals)
  row.games += w + d + l
  row.series += 1
  row.wins += w
  row.draws += d
  row.losses += l
  row.opponents.add(entrantKey(opponent))
  totals.set(key, row)
}

/** Entrants only have comparable ratings if results connect them, directly or
 *  through others. Two isolated cliques each get a self-consistent scale with no
 *  relationship between them, so only the largest component is rated. */
function largestComponent(count: number, pairings: Pairing[]): Set<number> {
  const adjacency: number[][] = Array.from({ length: count }, () => [])
  for (const { i, j } of pairings) {
    adjacency[i].push(j)
    adjacency[j].push(i)
  }

  const component = new Int32Array(count).fill(-1)
  const sizes: number[] = []
  for (let start = 0; start < count; start++) {
    if (component[start] !== -1) continue
    const id = sizes.length
    let size = 0
    const stack = [start]
    component[start] = id
    while (stack.length) {
      const node = stack.pop()!
      size++
      for (const next of adjacency[node]) {
        if (component[next] !== -1) continue
        component[next] = id
        stack.push(next)
      }
    }
    sizes.push(size)
  }

  let best = 0
  sizes.forEach((size, id) => {
    if (size > sizes[best]) best = id
  })
  const members = new Set<number>()
  for (let node = 0; node < count; node++) if (component[node] === best) members.add(node)
  return members
}

/** Coordinate-wise Newton ascent on the penalised log-likelihood. The objective
 *  is strictly concave under a Gaussian prior, so this converges to the unique
 *  optimum from any start and needs no step-size tuning. */
function fit(count: number, pairings: Pairing[]): { ratings: Float64Array; curvature: Float64Array } {
  const ratings = new Float64Array(count)
  const byEntrant: Pairing[][] = Array.from({ length: count }, () => [])
  for (const pairing of pairings) {
    byEntrant[pairing.i].push(pairing)
    byEntrant[pairing.j].push(pairing)
  }

  const precision = 1 / (PRIOR_SIGMA * PRIOR_SIGMA)
  const curvature = new Float64Array(count)

  for (let iteration = 0; iteration < MAX_ITERATIONS; iteration++) {
    let shift = 0
    for (let i = 0; i < count; i++) {
      let gradient = -ratings[i] * precision
      let information = precision
      for (const pairing of byEntrant[i]) {
        const opponent = pairing.i === i ? pairing.j : pairing.i
        const score = pairing.i === i ? pairing.scoreI : pairing.games - pairing.scoreI
        const expected = 1 / (1 + Math.exp(-(ratings[i] - ratings[opponent])))
        gradient += score - pairing.games * expected
        information += pairing.games * expected * (1 - expected)
      }
      curvature[i] = information
      const step = gradient / information
      ratings[i] += step
      shift = Math.max(shift, Math.abs(step))
    }
    if (shift < CONVERGENCE) break
  }

  return { ratings, curvature }
}

/** Slides the whole scale so the rated field averages the anchor.
 *
 *  Over the rated component only. The likelihood fixes differences, not the
 *  level, so this is a display convention — but averaging in entrants whose
 *  results never connect to the field made it one they could move: a single
 *  isolated clique shifted every published rating, and adding another shifted
 *  them again. Only players who are actually being compared set the level they
 *  are compared on. */
function recenter(ratings: Float64Array, rated: Set<number>) {
  const members = rated.size ? [...rated] : ratings.map((_, i) => i)
  let mean = 0
  for (const i of members) mean += ratings[i]
  mean /= members.length || 1
  for (let i = 0; i < ratings.length; i++) ratings[i] -= mean
}

export function rateEntrants(results: SeriesResult[]): RatedEntrant[] {
  const totals = new Map<string, Totals>()
  // Unordered pair -> A's score in games, with draws counting a half.
  const pairs = new Map<string, { i: Entrant; j: Entrant; scoreI: number; games: number }>()

  for (const result of results) {
    const games = result.wins + result.draws + result.losses
    if (games <= 0) continue
    accumulate(totals, result.a, result.b, result.wins, result.draws, result.losses)
    accumulate(totals, result.b, result.a, result.losses, result.draws, result.wins)

    const keyA = entrantKey(result.a)
    const keyB = entrantKey(result.b)
    if (keyA === keyB) continue
    const forward = keyA < keyB
    const key = forward ? `${keyA} ${keyB}` : `${keyB} ${keyA}`
    const scoreA = result.wins + result.draws / 2
    const entry = pairs.get(key) ?? {
      i: forward ? result.a : result.b,
      j: forward ? result.b : result.a,
      scoreI: 0,
      games: 0,
    }
    entry.scoreI += forward ? scoreA : games - scoreA
    entry.games += games
    pairs.set(key, entry)
  }

  const index = new Map<string, number>()
  const order: Totals[] = []
  for (const [key, row] of totals) {
    index.set(key, order.length)
    order.push(row)
  }
  if (!order.length) return []

  const pairings: Pairing[] = []
  for (const entry of pairs.values()) {
    // Rescale rather than truncate: an 80-game pairing at 75% still says 75%,
    // it just does not get to speak twice as loudly as everyone else.
    const weight = entry.games > PAIR_GAME_CAP ? PAIR_GAME_CAP / entry.games : 1
    pairings.push({
      i: index.get(entrantKey(entry.i))!,
      j: index.get(entrantKey(entry.j))!,
      scoreI: entry.scoreI * weight,
      games: entry.games * weight,
    })
  }

  const rated = largestComponent(order.length, pairings)
  const { ratings, curvature } = fit(order.length, pairings)
  recenter(ratings, rated)

  return order.map((row, i) => {
    const points = row.wins + row.draws / 2
    const connected = rated.has(i)
    return {
      model: row.entrant.model,
      effort: row.entrant.effort,
      rating: Math.round(ANCHOR + ratings[i] * SCALE),
      // Diagonal-only standard error: it ignores correlation between entrants,
      // so it understates slightly. It is a legibility cue, not a claim.
      ratingMargin: Math.round(1.96 * SCALE / Math.sqrt(curvature[i])),
      provisional: !connected || row.opponents.size < MIN_OPPONENTS,
      opponents: row.opponents.size,
      games: row.games,
      series: row.series,
      wins: row.wins,
      draws: row.draws,
      losses: row.losses,
      points,
      scorePct: row.games ? Math.round((points / row.games) * 1000) / 10 : 0,
    }
  })
}

/** Ranked entrants first by rating, then everything provisional — which cannot
 *  be ordered meaningfully against them — by score as a rough courtesy. */
export function sortStandings(entrants: RatedEntrant[]): RatedEntrant[] {
  return [...entrants].sort((a, b) => {
    if (a.provisional !== b.provisional) return a.provisional ? 1 : -1
    if (a.provisional) return b.scorePct - a.scorePct || b.games - a.games
    return b.rating - a.rating || b.games - a.games || a.model.localeCompare(b.model)
  })
}
