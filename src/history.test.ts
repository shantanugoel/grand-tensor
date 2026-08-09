import { describe, expect, test } from 'bun:test'
import {
  History,
  HISTORY_KEY,
  isComplete,
  leaderOf,
  LOG_LIMIT,
  parseHistory,
  SERIES_LIMIT,
  type KeyValueStore,
  type NewSnapshot,
} from './history'
import { DEFAULTS, type Settings } from './settings'
import type { GameRecord, PlayerStats } from './series'

/** A `Storage` face over a Map, optionally refusing writes past a byte budget
 *  the way a browser refuses them past its quota. */
function fakeStore(limit = Infinity) {
  const map = new Map<string, string>()
  const store: KeyValueStore & { size: () => number } = {
    getItem: (key) => map.get(key) ?? null,
    setItem: (key, value) => {
      if (value.length > limit) throw new DOMException('quota', 'QuotaExceededError')
      map.set(key, value)
    },
    removeItem: (key) => void map.delete(key),
    size: () => map.get(HISTORY_KEY)?.length ?? 0,
  }
  return store
}

const stats = (over: Partial<PlayerStats> = {}): PlayerStats => ({
  wins: 0,
  draws: 0,
  losses: 0,
  score: 0,
  moves: 0,
  illegal: 0,
  capped: 0,
  usage: { prompt: 0, completion: 0, reasoning: 0, total: 0, cost: 0, cacheRead: 0, cacheWrite: 0 },
  calls: 0,
  turns: 0,
  totalMs: 0,
  lastMs: 0,
  ...over,
})

const game = (index: number): GameRecord => ({
  index,
  white: (index % 2) as 0 | 1,
  result: '1-0',
  reason: 'checkmate',
  plies: 40,
  pgn: '1. e4 e5',
})

const snapshot = (id: string, over: Partial<NewSnapshot> = {}): NewSnapshot => ({
  id,
  status: 'running',
  stats: [stats(), stats()],
  games: [],
  gameIndex: 0,
  pgn: '',
  lastSay: ['', ''],
  resolvedEffort: null,
  settings: { ...structuredClone(DEFAULTS), apiKey: 'sk-secret' } as Settings,
  log: [],
  ...over,
})

describe('the stored file', () => {
  test('keeps the API key out of it', () => {
    const store = fakeStore()
    new History(store).save(snapshot('a'))

    expect(store.getItem(HISTORY_KEY)).not.toContain('sk-secret')
    expect(new History(store).get('a')?.settings.apiKey).toBe('')
  })

  test('holds the start time steady across updates', () => {
    const history = new History(fakeStore())
    history.save(snapshot('a'))
    const started = history.get('a')!.startedAt

    history.save(snapshot('a', { games: [game(0)] }))

    expect(history.get('a')!.startedAt).toBe(started)
    expect(history.get('a')!.games).toHaveLength(1)
  })

  test('lists the most recently touched match first', () => {
    const history = new History(fakeStore())
    history.save(snapshot('a'))
    history.save(snapshot('b'))
    history.save(snapshot('a', { games: [game(0)] }))

    expect(history.list().map((snap) => snap.id)).toEqual(['a', 'b'])
  })

  test('trims the battle log to what the on-screen one holds', () => {
    const history = new History(fakeStore())
    const log = Array.from({ length: LOG_LIMIT + 40 }, (_, i) => ({ kind: 'move' as const, text: `line ${i}` }))
    history.save(snapshot('a', { log }))

    const kept = history.get('a')!.log
    expect(kept).toHaveLength(LOG_LIMIT)
    // The tail is the part worth keeping — it is what the log was showing.
    expect(kept.at(-1)!.text).toBe(`line ${LOG_LIMIT + 39}`)
  })

  test('survives a corrupt or foreign entry instead of losing the archive', () => {
    const file = parseHistory(
      JSON.stringify({
        version: 1,
        currentId: 'good',
        series: [{ id: 'junk' }, null, 'nope', { ...snapshot('good'), startedAt: 1, updatedAt: 2 }],
      }),
    )

    expect(file.series.map((snap) => snap.id)).toEqual(['good'])
    expect(file.currentId).toBe('good')
  })

  test('drops a current pointer that names nothing', () => {
    expect(parseHistory(JSON.stringify({ version: 1, currentId: 'gone', series: [] })).currentId).toBeNull()
    expect(parseHistory('not json').series).toEqual([])
    expect(parseHistory(null).currentId).toBeNull()
  })
})

describe('pruning', () => {
  test('keeps the archive to its limit, oldest out first', () => {
    const history = new History(fakeStore())
    for (let i = 0; i < SERIES_LIMIT + 5; i++) history.save(snapshot(`s${i}`))

    const ids = history.list().map((snap) => snap.id)
    expect(ids).toHaveLength(SERIES_LIMIT)
    expect(ids[0]).toBe(`s${SERIES_LIMIT + 4}`)
    expect(ids).not.toContain('s0')
  })

  test('sheds old matches until a nearly full store takes the write', () => {
    // Room for roughly a couple of entries, so most of a long archive has to go.
    const store = fakeStore(2600)
    const history = new History(store)
    for (let i = 0; i < 12; i++) history.save(snapshot(`s${i}`, { games: [game(0), game(1)] }))

    const ids = history.list().map((snap) => snap.id)
    expect(ids.length).toBeGreaterThan(0)
    expect(ids.length).toBeLessThan(12)
    // Whatever survives is the recent end of the archive.
    expect(ids[0]).toBe('s11')
    expect(store.size()).toBeLessThanOrEqual(2600)
  })

  test('never sheds the match on screen', () => {
    const store = fakeStore(2600)
    const history = new History(store)
    history.save(snapshot('live', { games: [game(0), game(1)] }))
    history.setCurrent('live')
    for (let i = 0; i < 12; i++) history.save(snapshot(`s${i}`, { games: [game(0), game(1)] }))

    expect(history.get('live')).toBeDefined()
    expect(new History(store).get('live')).toBeDefined()
  })
})

describe('removal', () => {
  test('takes the current pointer with it', () => {
    const store = fakeStore()
    const history = new History(store)
    history.save(snapshot('a'))
    history.setCurrent('a')

    history.remove('a')

    expect(history.list()).toEqual([])
    expect(history.currentId).toBeNull()
    expect(new History(store).currentId).toBeNull()
  })

  test('clear empties the store outright', () => {
    const store = fakeStore()
    const history = new History(store)
    history.save(snapshot('a'))
    history.clear()

    expect(store.getItem(HISTORY_KEY)).toBeNull()
    expect(new History(store).list()).toEqual([])
  })
})

describe('reading a snapshot', () => {
  test('calls a series complete on its last game, however it was left', () => {
    const played = (n: number) => ({
      ...snapshot('a', { games: Array.from({ length: n }, (_, i) => game(i)) }),
      startedAt: 0,
      updatedAt: 0,
    })
    expect(isComplete({ ...played(2), settings: { ...DEFAULTS, games: 2 } })).toBe(true)
    expect(isComplete({ ...played(1), settings: { ...DEFAULTS, games: 2 } })).toBe(false)
    // A series stopped early but marked done — an adjudicated finish — still is.
    expect(isComplete({ ...played(1), status: 'done', settings: { ...DEFAULTS, games: 2 } })).toBe(true)
  })

  test('reads the leader off the stored score', () => {
    const withScores = (a: number, b: number) => ({
      ...snapshot('a', { stats: [stats({ score: a }), stats({ score: b })] }),
      startedAt: 0,
      updatedAt: 0,
    })
    expect(leaderOf(withScores(1.5, 0.5))).toBe(0)
    expect(leaderOf(withScores(0, 2))).toBe(1)
    expect(leaderOf(withScores(1, 1))).toBeNull()
  })
})
