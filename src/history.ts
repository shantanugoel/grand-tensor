/** Match history, and the reload-proofing that falls out of it.
 *
 *  Every series the arena has played is a row in one stored file — the live one
 *  included. That is deliberate: "put back what I was watching before the
 *  refresh" and "let me look at last night's match again" are the same read of
 *  the same record, so there is one shape and one store rather than an autosave
 *  slot that drifts out of step with an archive beside it.
 *
 *  Nothing here touches the DOM, and the backing store is injected rather than
 *  reached for — so the part most likely to misbehave, what gets shed when the
 *  quota runs out, can be tested without a browser.
 *
 *  The API key is never written. A snapshot carries the settings its match was
 *  played under because the score, the labels and a resumed move all have to
 *  agree with them, but the key is stripped on the way in and supplied from the
 *  live settings on the way out. */

import type { LogEntry, SeriesState } from './series'
import type { Settings } from './settings'

export const HISTORY_KEY = 'grand-tensor:history:1'

/** Battle-log lines kept per series. The same cap the on-screen log uses, so a
 *  restored match shows exactly as much as a live one would. */
export const LOG_LIMIT = 300

/** Series kept before the least recently touched one is dropped. */
export const SERIES_LIMIT = 30

/** What `save` is handed. Timestamps are the store's business, not the caller's:
 *  a series keeps the `startedAt` it was first written with however many times
 *  it is updated afterwards. */
export type NewSnapshot = SeriesState & {
  id: string
  settings: Settings
  log: LogEntry[]
}

export type SeriesSnapshot = NewSnapshot & {
  startedAt: number
  updatedAt: number
}

export type HistoryFile = {
  version: 1
  /** The series the arena is showing, so a reload knows what to put back. Null
   *  once it has been reset away. */
  currentId: string | null
  /** Most recently touched first. Pruning eats from the far end. */
  series: SeriesSnapshot[]
}

/** The slice of `Storage` this needs. Injected so tests can hand over a Map. */
export type KeyValueStore = Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>

const emptyFile = (): HistoryFile => ({ version: 1, currentId: null, series: [] })

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null

/** Deliberately shallow. This is guarding against a corrupt or foreign entry
 *  taking the whole archive down, not validating chess — a snapshot that parses
 *  but holds nonsense costs one unplayable row, and `Series.restore` is written
 *  to survive a PGN it cannot load. */
function isSnapshot(value: unknown): value is SeriesSnapshot {
  if (!isRecord(value)) return false
  const settings = value.settings
  return (
    typeof value.id === 'string' &&
    typeof value.gameIndex === 'number' &&
    typeof value.pgn === 'string' &&
    Array.isArray(value.games) &&
    Array.isArray(value.stats) &&
    value.stats.length === 2 &&
    isRecord(settings) &&
    Array.isArray(settings.players) &&
    settings.players.length === 2 &&
    typeof settings.games === 'number'
  )
}

export function parseHistory(raw: string | null): HistoryFile {
  if (!raw) return emptyFile()
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    return emptyFile()
  }
  if (!isRecord(parsed) || !Array.isArray(parsed.series)) return emptyFile()

  const series = parsed.series.filter(isSnapshot).map((snap) => ({
    ...snap,
    startedAt: typeof snap.startedAt === 'number' ? snap.startedAt : Date.now(),
    updatedAt: typeof snap.updatedAt === 'number' ? snap.updatedAt : Date.now(),
    log: Array.isArray(snap.log) ? snap.log : [],
  }))
  series.sort((a, b) => b.updatedAt - a.updatedAt)

  const currentId = typeof parsed.currentId === 'string' ? parsed.currentId : null
  return {
    version: 1,
    currentId: series.some((snap) => snap.id === currentId) ? currentId : null,
    series,
  }
}

/** Serialises the file, shedding the oldest series until the store will take it.
 *
 *  The series on screen is never a candidate: losing that one to a full store is
 *  exactly the failure this file exists to prevent. A store that refuses even
 *  that costs the archive and nothing else, so the write gives up quietly rather
 *  than throwing into the middle of a match. */
function write(store: KeyValueStore, file: HistoryFile): void {
  const keep = file.series.slice(0, SERIES_LIMIT)
  // A pruned-away current series would leave the pointer dangling.
  if (file.currentId && !keep.some((snap) => snap.id === file.currentId)) {
    const current = file.series.find((snap) => snap.id === file.currentId)
    if (current) keep.splice(SERIES_LIMIT - 1, keep.length, current)
  }

  for (;;) {
    try {
      store.setItem(HISTORY_KEY, JSON.stringify({ ...file, series: keep }))
      file.series = keep
      return
    } catch {
      let victim = keep.length - 1
      while (victim >= 0 && keep[victim].id === file.currentId) victim--
      if (victim < 0) {
        // Only the live series is left and it still won't fit. Nothing more to
        // give up, so the in-memory file stays authoritative for this session.
        return
      }
      keep.splice(victim, 1)
    }
  }
}

export class History {
  private file: HistoryFile

  constructor(private store: KeyValueStore = localStorage) {
    let raw: string | null = null
    try {
      raw = store.getItem(HISTORY_KEY)
    } catch {
      // A disabled store costs history and reload-proofing, and nothing else.
    }
    this.file = parseHistory(raw)
  }

  /** Most recently touched first. */
  list(): SeriesSnapshot[] {
    return this.file.series
  }

  get(id: string): SeriesSnapshot | undefined {
    return this.file.series.find((snap) => snap.id === id)
  }

  get currentId(): string | null {
    return this.file.currentId
  }

  setCurrent(id: string | null) {
    this.file.currentId = id
    write(this.store, this.file)
  }

  /** Writes a series, creating the row on first sight and updating it after. */
  save(entry: NewSnapshot) {
    const existing = this.get(entry.id)
    const snapshot: SeriesSnapshot = {
      ...entry,
      // The key is the one thing a shared or exported archive must never carry.
      settings: { ...structuredClone(entry.settings), apiKey: '' },
      log: entry.log.slice(-LOG_LIMIT),
      startedAt: existing?.startedAt ?? Date.now(),
      updatedAt: Date.now(),
    }
    this.file.series = [snapshot, ...this.file.series.filter((snap) => snap.id !== entry.id)]
    write(this.store, this.file)
  }

  remove(id: string) {
    this.file.series = this.file.series.filter((snap) => snap.id !== id)
    if (this.file.currentId === id) this.file.currentId = null
    write(this.store, this.file)
  }

  clear() {
    this.file = emptyFile()
    try {
      this.store.removeItem(HISTORY_KEY)
    } catch {
      /* nothing to do — the entry is unreachable either way */
    }
  }
}

/* ---------- reading a snapshot ---------- */

/** How far through the series a snapshot is. */
export const gamesPlayed = (snap: SeriesSnapshot) => snap.games.length

export const isComplete = (snap: SeriesSnapshot) =>
  snap.status === 'done' || snap.games.length >= snap.settings.games

/** Series score, straight off the stored stats. */
export const scoreOf = (snap: SeriesSnapshot): [number, number] => [
  snap.stats[0]?.score ?? 0,
  snap.stats[1]?.score ?? 0,
]

/** Whoever is ahead, or null for level. */
export function leaderOf(snap: SeriesSnapshot): 0 | 1 | null {
  const [a, b] = scoreOf(snap)
  if (a === b) return null
  return a > b ? 0 : 1
}
