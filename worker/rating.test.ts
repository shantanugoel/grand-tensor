import { describe, expect, test } from 'bun:test'
import { MIN_OPPONENTS, PAIR_GAME_CAP, rateEntrants, sortStandings, type SeriesResult } from './rating'

const series = (
  a: string,
  b: string,
  wins: number,
  draws: number,
  losses: number,
  efforts: [string, string] = ['default', 'default'],
): SeriesResult => ({
  a: { model: a, effort: efforts[0] },
  b: { model: b, effort: efforts[1] },
  wins,
  draws,
  losses,
})

const repeat = (count: number, make: (index: number) => SeriesResult) => Array.from({ length: count }, (_, i) => make(i))

const find = (rated: ReturnType<typeof rateEntrants>, model: string, effort = 'default') =>
  rated.find((entrant) => entrant.model === model && entrant.effort === effort)!

describe('bradley-terry standings', () => {
  test('separates one model’s effort levels into distinct entrants', () => {
    const rated = rateEntrants([
      series('gpt', 'claude', 4, 0, 0, ['high', 'default']),
      series('gpt', 'claude', 0, 0, 4, ['low', 'default']),
    ])

    expect(rated).toHaveLength(3)
    expect(find(rated, 'gpt', 'high').rating).toBeGreaterThan(find(rated, 'gpt', 'low').rating)
  })

  test('an unconnected clique does not move the ratings of the rated field', () => {
    const field: SeriesResult[] = [
      ...repeat(4, () => series('strong', 'middle', 3, 1, 0)),
      ...repeat(4, () => series('middle', 'weak', 3, 1, 0)),
      ...repeat(4, () => series('strong', 'weak', 4, 0, 0)),
    ]
    const before = rateEntrants(field)

    // Two entrants who only ever played each other, lopsidedly. They share no
    // opponent with the field, so nothing about them is comparable to it — and
    // their arrival must not renumber everyone else.
    const withOutsiders = rateEntrants([...field, ...repeat(4, () => series('island-a', 'island-b', 4, 0, 0))])

    for (const model of ['strong', 'middle', 'weak'])
      expect(find(withOutsiders, model).rating).toBe(find(before, model).rating)

    expect(find(withOutsiders, 'island-a').provisional).toBe(true)
    expect(find(withOutsiders, 'island-b').provisional).toBe(true)
  })

  test('rates a model that only beats weak opponents below one that beats strong ones', () => {
    // weak < middle < strong, established by direct results, and then two
    // challengers with identical raw scores against different opposition.
    const results: SeriesResult[] = [
      ...repeat(4, () => series('strong', 'middle', 3, 1, 0)),
      ...repeat(4, () => series('middle', 'weak', 3, 1, 0)),
      ...repeat(4, () => series('strong', 'weak', 4, 0, 0)),
      // Farmer plays nothing but the weakest entrant, and sweeps every game.
      ...repeat(8, () => series('farmer', 'weak', 4, 0, 0)),
      // Honest plays the top of the field over the same number of games, and
      // drops some of them.
      ...repeat(4, () => series('honest', 'strong', 3, 0, 1)),
      ...repeat(4, () => series('honest', 'middle', 4, 0, 0)),
    ]

    const rated = rateEntrants(results)
    const farmer = find(rated, 'farmer')
    const honest = find(rated, 'honest')

    // Same games played, and the farmer's raw score is the better of the two —
    // a perfect record against the field's weakest entrant.
    expect(farmer.games).toBe(honest.games)
    expect(farmer.scorePct).toBe(100)
    expect(honest.scorePct).toBeLessThan(farmer.scorePct)
    // The rating inverts that, which is the whole point.
    expect(honest.rating).toBeGreaterThan(farmer.rating)
  })

  test('marks entrants with too few distinct opponents provisional', () => {
    const rated = rateEntrants([
      ...repeat(3, () => series('a', 'b', 2, 0, 2)),
      ...repeat(3, () => series('a', 'c', 2, 0, 2)),
      ...repeat(3, () => series('a', 'd', 2, 0, 2)),
    ])

    expect(find(rated, 'a').opponents).toBe(MIN_OPPONENTS)
    expect(find(rated, 'a').provisional).toBe(false)
    expect(find(rated, 'b').opponents).toBe(1)
    expect(find(rated, 'b').provisional).toBe(true)
  })

  test('caps how far one grinding pairing can move a rating', () => {
    const baseline = [
      ...repeat(4, () => series('a', 'b', 4, 0, 0)),
      ...repeat(4, () => series('a', 'c', 2, 0, 2)),
      ...repeat(4, () => series('a', 'd', 2, 0, 2)),
      ...repeat(4, () => series('b', 'c', 2, 0, 2)),
      ...repeat(4, () => series('c', 'd', 2, 0, 2)),
    ]
    // Twenty times the games against the same opponent, same 100% rate.
    const ground = [...baseline, ...repeat(76, () => series('a', 'b', 4, 0, 0))]

    const before = find(rateEntrants(baseline), 'a').rating
    const after = find(rateEntrants(ground), 'a').rating

    expect(find(rateEntrants(ground), 'a').games).toBeGreaterThan(PAIR_GAME_CAP)
    // Some movement is legitimate — more evidence sharpens the estimate — but it
    // must not scale with how many times one matchup was replayed.
    expect(Math.abs(after - before)).toBeLessThan(120)
  })

  test('does not rate entrants whose results never connect to the main field', () => {
    // Both groups play round-robin, so everyone clears the opponent minimum and
    // disconnection is the only thing left that can disqualify the island.
    const roundRobin = (names: string[]) =>
      names.flatMap((a, i) => names.slice(i + 1).flatMap((b) => repeat(3, () => series(a, b, 2, 0, 2))))

    const rated = rateEntrants([...roundRobin(['a', 'b', 'c', 'd', 'e']), ...roundRobin(['x', 'y', 'z', 'w'])])

    expect(find(rated, 'x').opponents).toBeGreaterThanOrEqual(MIN_OPPONENTS)
    expect(find(rated, 'a').provisional).toBe(false)
    expect(find(rated, 'x').provisional).toBe(true)
  })

  test('anchors the rated field at 1500', () => {
    const rated = rateEntrants([
      ...repeat(3, () => series('a', 'b', 3, 0, 1)),
      ...repeat(3, () => series('b', 'c', 3, 0, 1)),
      ...repeat(3, () => series('a', 'c', 3, 0, 1)),
    ])

    const mean = rated.reduce((sum, entrant) => sum + entrant.rating, 0) / rated.length
    expect(mean).toBeCloseTo(1500, 0)
  })

  test('counts draws as half a point on both sides', () => {
    const rated = rateEntrants([series('a', 'b', 0, 4, 0)])
    expect(find(rated, 'a').points).toBe(2)
    expect(find(rated, 'a').scorePct).toBe(50)
    expect(find(rated, 'b').points).toBe(2)
    expect(find(rated, 'a').rating).toBe(find(rated, 'b').rating)
  })

  test('lists provisional entrants after every ranked one', () => {
    const sorted = sortStandings(
      rateEntrants([
        ...repeat(3, () => series('a', 'b', 2, 0, 2)),
        ...repeat(3, () => series('a', 'c', 2, 0, 2)),
        ...repeat(3, () => series('b', 'c', 2, 0, 2)),
        ...repeat(3, () => series('a', 'd', 4, 0, 0)),
      ]),
    )

    const firstProvisional = sorted.findIndex((entrant) => entrant.provisional)
    expect(firstProvisional).toBeGreaterThan(0)
    expect(sorted.slice(firstProvisional).every((entrant) => entrant.provisional)).toBe(true)
  })
})
