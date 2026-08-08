import './style.css'
import './build-info'
import { Chess } from 'chess.js'
import { Arena } from './three/arena'
import { material, MAX_MATERIAL } from './adjudication'
import { Series, type GameRecord, type PlayerStats } from './series'
import { loadSettings, saveSettings, isFirstVisit, DEFAULTS, SPEEDS, effectiveSpeedIndex, type Settings } from './settings'
import { Hud } from './ui/hud'
import { readSettings, renderSettings } from './ui/settings-ui'
import {
  applyMatchHash,
  canNativeShare,
  copyText,
  fmtScore,
  matchFilename,
  nativeShare,
  postText,
  resultText,
  shareUrl,
  tweetUrl,
} from './share'
import { cardFile, copyImageToClipboard, downloadBlob, downloadImage, renderResultCard } from './share-image'
import { buildStoryboard, cardMsFor, estimateMs, paceFor, POST_LIMIT_MS } from './replay'
import { canRecordVideo, extensionFor, recordSeriesVideo } from './share-video'
import { dismissRotateHint, setupMobile } from './ui/mobile'
import { SummaryModal, type SummaryRow, type SummaryView } from './ui/summary'
import { VideoProgress } from './ui/video-progress'
import { Leaderboard } from './leaderboard'
import { History, type SeriesSnapshot } from './history'
import { HistoryModal, type HistoryAction } from './ui/history-ui'

const $ = <T extends HTMLElement = HTMLElement>(sel: string) => document.querySelector(sel) as T

/** How long the K.O. slam gets before the scoreboard slides over it. */
const VERDICT_MS = 1300
const COUNTDOWN_SECONDS = 3

const firstVisit = isFirstVisit()
const settings: Settings = loadSettings()
// A shared link carries the matchup but never a key, so it overrides the models
// and then still needs the visitor's own credentials.
const fromLink = applyMatchHash(settings)
const arena = new Arena($('#stage'))
const hud = new Hud(settings)
const summary = new SummaryModal()
const leaderboard = new Leaderboard((message) => hud.toast(message))
const videoProgress = new VideoProgress()
const history = new History()
let series: Series | null = null
/** Which row in the history file the series on screen belongs to. Null for a
 *  board that has never been started — an empty match is not worth a record. */
let currentId: string | null = null
/** A video export drives the arena and the speed dial itself, so everything that
 *  would fight it over either is locked out for the duration. */
let exporting = false
/** Stats as they stood when the current game began, so the round card can show
 *  what that game alone cost rather than the running series totals. */
let statsAtGameStart: [PlayerStats, PlayerStats] | null = null

function newSeries(): Series {
  return new Series(settings, {
    onGameStart: (index, white) => {
      statsAtGameStart = structuredClone(series!.stats)
      arena.setPosition(series!.chess)
      hud.log({ kind: 'info', text: `Game ${index + 1} — ${settings.players[white].label} has white` })
      hud.render(series!)
      persistNow()
    },
    onMove: async (e) => {
      await arena.animateMove(e.move, series!.chess, { check: e.check, mate: e.mate })
      persist()
    },
    onGameEnd: async (rec) => {
      persistNow()
      if (rec.result === '1/2-1/2') {
        arena.announce('DRAW', '#8fa5d6')
        hud.announce('DRAW')
      } else {
        arena.announce(rec.result === '1-0' ? 'WHITE WINS' : 'BLACK WINS', '#ffd54a')
        // Winning without conceding a single piece earns the arcade "PERFECT".
        const winnerColor = rec.result === '1-0' ? 'w' : 'b'
        hud.announce(material(series!.chess, winnerColor) === MAX_MATERIAL ? 'PERFECT' : 'K.O.')
      }

      // The last round rolls straight into the series card instead.
      if (rec.index >= series!.totalGames - 1) return
      const active = series
      await sleep(VERDICT_MS)
      // A reset during the slam swaps in a fresh series — don't interrupt it.
      if (series !== active) return
      await summary.interstitial(roundView(rec), COUNTDOWN_SECONDS)
    },
    onThinking: (player) => {
      hud.setThinking(player)
      hud.render(series!)
    },
    onLog: (entry) => {
      hud.log(entry)
      // A stall is the one line that has to reach someone who has scrolled away
      // from the battle log — or walked away from the screen entirely.
      if (entry.kind === 'error') hud.toast(entry.detail ? `${entry.text} — ${entry.detail}` : entry.text)
    },
    onUpdate: () => {
      hud.render(series!)
      syncStatus()
      // Stalls and retries both arrive mid-run, so the buttons can't wait for
      // the series to finish to catch up with the status.
      setControls()
      persist()
    },
  })
}

/* ---------- saved matches ---------- */

/** How long a burst of updates is allowed to coalesce.
 *
 *  `onUpdate` fires several times per turn and a write serialises the whole
 *  archive, so this wants to be generous rather than eager. What it costs is the
 *  last second and a half of a match if the tab dies without warning — and a
 *  real turn takes minutes, so in practice that is nothing. Everything that
 *  marks actual progress (a game starting or ending, pause, the tab going away)
 *  flushes on the spot regardless. */
const PERSIST_MS = 1500
let persistTimer: ReturnType<typeof setTimeout> | undefined

function persistNow() {
  clearTimeout(persistTimer)
  persistTimer = undefined
  if (!series || !currentId) return
  history.save({ id: currentId, settings, log: hud.logEntries, ...series.state() })
}

function persist() {
  if (!series || !currentId) return
  persistTimer ??= setTimeout(persistNow, PERSIST_MS)
}

// A phone backgrounding the tab may never come back to it, and `pagehide` is
// the only one of these that fires reliably on iOS.
addEventListener('pagehide', persistNow)
addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'hidden') persistNow()
})

/** Puts a saved match back on the board.
 *
 *  The matchup comes with it. A series is only meaningful alongside the settings
 *  it was played under — the labels on the cards, the models in the share card,
 *  and the endpoint a resumed move goes out to — so opening one adopts them,
 *  keeping the live API key and the viewer's current speed preference. */
function loadSnapshot(snap: SeriesSnapshot) {
  series?.stop()
  summary.close()
  card = null
  leaderboard.idle()

  Object.assign(settings, structuredClone(snap.settings), { apiKey: settings.apiKey, speed: settings.speed })
  saveSettings(settings)
  hud.setSettings(settings)

  currentId = snap.id
  history.setCurrent(snap.id)
  series = newSeries()
  series.restore(snap)
  hud.restoreLog(snap.log)
  hud.setThinking(null)
  arena.setPosition(series.chess)
  hud.render(series)
  syncStatus()
  setControls()
}

const historyModal = new HistoryModal({
  list: () => history.list(),
  currentId: () => currentId,
  isPlaying: () =>
    series?.status === 'running' || series?.status === 'paused' || series?.status === 'stalled',
  canRecordVideo: canRecordVideo(),
  act: (action, id) => void historyAction(action, id),
  clearAll: () => {
    currentId = null
    history.clear()
    reset()
    hud.toast('Match history cleared.')
  },
})

async function historyAction(action: HistoryAction, id: string) {
  if (action === 'delete') {
    const wasCurrent = id === currentId
    // Cleared first, or the reset below would save the row straight back.
    if (wasCurrent) currentId = null
    history.remove(id)
    if (wasCurrent) reset()
    historyModal.refresh()
    return
  }

  const snap = history.get(id)
  if (!snap) return
  // Every export reads the live arena and the live series, so the match has to
  // be on the board before any of them can speak for it.
  if (id !== currentId) loadSnapshot(snap)

  if (action === 'open') {
    historyModal.close()
    return
  }
  if (action === 'resume') {
    historyModal.close()
    await startSeries()
    return
  }
  historyModal.close()
  await share(action)
}

$('#btn-history').addEventListener('click', () => historyModal.open())

/* ---------- round & series summaries ---------- */

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms))

const fmtTokens = (n: number) =>
  n >= 1_000_000 ? `${(n / 1_000_000).toFixed(1)}M` : n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n)
const fmtCost = (n: number) => (n > 0 ? `$${n < 0.01 ? n.toFixed(4) : n.toFixed(2)}` : '—')
const fmtMs = (n: number) => (n >= 1000 ? `${(n / 1000).toFixed(1)}s` : `${Math.round(n)}ms`)

/** Lower is better for illegal moves, so the lead flips. */
const leadHigh = (a: number, b: number) => (a === b ? null : a > b ? 0 : 1)
const leadLow = (a: number, b: number) => (a === b ? null : a < b ? 0 : 1)

/** Truncated replies get their own line, but only once one has happened —
 *  a zero-vs-zero row is noise on a card most matches never need. */
const cappedRow = (a: number, b: number): SummaryRow[] =>
  a || b ? [{ label: 'CAPPED', a: String(a), b: String(b), lead: leadLow(a, b) }] : []

/** What one game cost a player, as the difference against the series totals
 *  captured when that game kicked off. */
function gameDelta(now: PlayerStats, before?: PlayerStats) {
  return {
    moves: now.moves - (before?.moves ?? 0),
    illegal: now.illegal - (before?.illegal ?? 0),
    capped: now.capped - (before?.capped ?? 0),
    tokens: now.usage.total - (before?.usage.total ?? 0),
    cost: now.usage.cost - (before?.usage.cost ?? 0),
    turns: now.turns - (before?.turns ?? 0),
    totalMs: now.totalMs - (before?.totalMs ?? 0),
  }
}

function roundView(rec: GameRecord): SummaryView {
  const s = series!
  const black = (1 - rec.white) as 0 | 1
  const winner = rec.result === '1/2-1/2' ? null : rec.result === '1-0' ? rec.white : black
  const [a, b] = s.stats.map((st, i) => gameDelta(st, statsAtGameStart?.[i])) as [
    ReturnType<typeof gameDelta>,
    ReturnType<typeof gameDelta>,
  ]
  const outcome = (i: 0 | 1) => (winner === null ? 'Drew' : winner === i ? 'Won' : 'Lost')
  const avg = (d: ReturnType<typeof gameDelta>) => (d.turns ? fmtMs(d.totalMs / d.turns) : '—')

  const rows: SummaryRow[] = [
    { label: 'SIDE', a: rec.white === 0 ? 'White' : 'Black', b: rec.white === 0 ? 'Black' : 'White' },
    { label: 'RESULT', a: outcome(0), b: outcome(1), lead: winner },
    { label: 'MOVES', a: String(a.moves), b: String(b.moves) },
    { label: 'TOKENS', a: fmtTokens(a.tokens), b: fmtTokens(b.tokens) },
    { label: 'ILLEGAL', a: String(a.illegal), b: String(b.illegal), lead: leadLow(a.illegal, b.illegal) },
    ...cappedRow(a.capped, b.capped),
    { label: 'AVG THINK', a: avg(a), b: avg(b), lead: leadLow(a.turns ? a.totalMs / a.turns : Infinity, b.turns ? b.totalMs / b.turns : Infinity) },
    { label: 'COST', a: fmtCost(a.cost), b: fmtCost(b.cost) },
  ]

  return {
    title: `Round ${rec.index + 1} of ${s.totalGames}`,
    headline: winner === null ? 'DRAW' : `${settings.players[winner].label.toUpperCase()} WINS`,
    headlineKind: winner === null ? 'draw' : winner === 0 ? 'p0' : 'p1',
    detail: `${rec.reason} · ${Math.ceil(rec.plies / 2)} moves`,
    names: [settings.players[0].label, settings.players[1].label],
    score: [fmtScore(s.stats[0].score), fmtScore(s.stats[1].score)],
    scoreLabel: 'Series score',
    rows,
  }
}

function seriesView(): SummaryView {
  const s = series!
  const [a, b] = s.stats
  const leader = s.leader
  const avg = (st: PlayerStats) => (st.turns ? fmtMs(st.totalMs / st.turns) : '—')
  const totalCost = a.usage.cost + b.usage.cost

  const rows: SummaryRow[] = [
    {
      label: 'W / D / L',
      a: `${a.wins}/${a.draws}/${a.losses}`,
      b: `${b.wins}/${b.draws}/${b.losses}`,
      lead: leadHigh(a.wins, b.wins),
    },
    { label: 'MOVES', a: String(a.moves), b: String(b.moves) },
    { label: 'TOKENS', a: fmtTokens(a.usage.total), b: fmtTokens(b.usage.total) },
    { label: 'REASONING', a: fmtTokens(a.usage.reasoning), b: fmtTokens(b.usage.reasoning) },
    { label: 'ILLEGAL', a: String(a.illegal), b: String(b.illegal), lead: leadLow(a.illegal, b.illegal) },
    ...cappedRow(a.capped, b.capped),
    { label: 'AVG THINK', a: avg(a), b: avg(b) },
    { label: 'COST', a: fmtCost(a.usage.cost), b: fmtCost(b.usage.cost) },
  ]

  return {
    title: 'Series complete',
    headline: leader === null ? 'SERIES DRAWN' : `${settings.players[leader].label.toUpperCase()} TAKES THE CROWN`,
    headlineKind: leader === null ? 'draw' : leader === 0 ? 'p0' : 'p1',
    detail: `${s.games.length} games · ${a.moves + b.moves} moves · ${fmtTokens(a.usage.total + b.usage.total)} tokens${
      totalCost > 0 ? ` · ${fmtCost(totalCost)}` : ''
    }`,
    names: [settings.players[0].label, settings.players[1].label],
    score: [fmtScore(a.score), fmtScore(b.score)],
    scoreLabel: `Best of ${s.totalGames}`,
    rows,
  }
}

/** The summary's Submit button is a stand-in for the verdict card's, so it has
 *  to carry the same eligibility state. */
function showSeriesSummary() {
  const real = $<HTMLButtonElement>('#btn-submit-leaderboard')
  const proxy = $<HTMLButtonElement>('#summary-share [data-share="submit"]')
  proxy.disabled = real.disabled
  proxy.title = real.title
  summary.final(seriesView())
  // The board has settled, so this is the moment to grab the arena still.
  void buildCard()
}

function syncStatus() {
  if (!series) return hud.setStatus('IDLE')
  // A restored series is parked, not idle: it has a score and a board, and the
  // only thing missing is someone pressing Resume.
  if (series.resumable) return hud.setStatus(`GAME ${series.gameIndex + 1}/${series.totalGames} PAUSED`)
  switch (series.status) {
    case 'running':
      return hud.setStatus(`GAME ${series.gameIndex + 1}/${series.totalGames} LIVE`, 'live')
    case 'paused':
      return hud.setStatus('PAUSED')
    case 'stalled':
      return hud.setStatus('STALLED', 'err')
    case 'done': {
      const leader = series.leader
      return hud.setStatus(leader === null ? 'SERIES DRAWN' : `${settings.players[leader].label.toUpperCase()} WINS`, 'live')
    }
    case 'error':
      return hud.setStatus('ERROR', 'err')
    default:
      return hud.setStatus('IDLE')
  }
}

function setControls() {
  // A stalled series is still live — it is parked mid-move waiting to be sent
  // again, so Pause doubles as the Retry button rather than Start being re-armed.
  const stalled = series?.status === 'stalled'
  const running = series?.status === 'running' || series?.status === 'paused' || stalled
  $<HTMLButtonElement>('#btn-run').disabled = running || exporting
  $<HTMLButtonElement>('#btn-pause').disabled = !running || exporting
  $<HTMLButtonElement>('#btn-reset').disabled = exporting
  $('#btn-pause').textContent = stalled ? '↻ Retry' : series?.status === 'paused' ? '▶ Resume' : '❚❚ Pause'
  $('#btn-pause').classList.toggle('primary', stalled)
  // A match restored from history carries on rather than starting over, and the
  // button has to say so — pressing Start on it would otherwise read as a threat
  // to the score already on the board.
  $('#btn-run').textContent = series?.resumable ? '▶ Resume' : '▶ Start'
}

/* ---------- controls ---------- */

async function startSeries() {
  if (series?.status === 'running' || series?.status === 'paused' || series?.status === 'stalled') return
  const needsKey = settings.players.some((p) => p.model.trim().toLowerCase() !== 'random')
  if (needsKey && !settings.apiKey) {
    hud.toast('Add an API key in Settings, or set a model to "random" to watch a demo match.')
    openModal()
    return
  }
  dismissRotateHint()
  // A restored match keeps its board, its score and its battle log — only a
  // genuinely new one gets dealt from scratch.
  if (!series?.resumable) {
    hud.clearLog()
    card = null
    series = newSeries()
    currentId = crypto.randomUUID()
    history.setCurrent(currentId)
  }
  const leaderboardRun = leaderboard.prepare(settings)
  arena.setPosition(series.chess)
  hud.render(series)
  const finished = series.run()
  setControls()
  persistNow()
  await finished
  if (series.status === 'error') hud.toast(series.errorMessage)
  persistNow()
  setControls()
  syncStatus()
  // Let the round's K.O. slam clear before the match verdict lands on top of it.
  if (series.status === 'done') {
    const finishedSeries = series
    leaderboard.complete(series, await leaderboardRun)
    const leader = series.leader
    setTimeout(() => hud.announce(leader === null ? 'DRAW MATCH' : 'CHAMPION'), VERDICT_MS)
    await sleep(VERDICT_MS + 900)
    if (series === finishedSeries) showSeriesSummary()
  }
}

$('#btn-run').addEventListener('click', () => void startSeries())

$('#btn-pause').addEventListener('click', () => {
  if (!series) return
  if (series.status === 'stalled') series.retry()
  else series.status === 'paused' ? series.resume() : series.pause()
  setControls()
  syncStatus()
  persistNow()
})

function reset() {
  // Clearing the board is about the next match, not a decision to throw away
  // the last one — so whatever was on it is written out first, and stays in
  // History to be resumed or exported later.
  persistNow()
  series?.stop()
  // Frees whatever round is parked on the countdown before the series is swapped.
  summary.close()
  card = null
  leaderboard.idle()
  currentId = null
  history.setCurrent(null)
  series = newSeries()
  hud.clearLog()
  hud.setThinking(null)
  arena.setPosition(series.chess)
  hud.render(series)
  hud.setStatus('IDLE')
  setControls()
}

$('#btn-reset').addEventListener('click', reset)

const speedInput = $<HTMLInputElement>('#speed')
function applySpeed() {
  settings.speed = Number(speedInput.value)
  const effectiveIndex = effectiveSpeedIndex(settings)
  const s = SPEEDS[effectiveIndex] ?? SPEEDS[3]
  // A video export owns the speed dial while it runs and hands it back here.
  if (!exporting) arena.speed = s.anim
  $('#speed-label').textContent = effectiveIndex === settings.speed ? s.label : `${s.label} demo`
  saveSettings(settings)
}
speedInput.addEventListener('input', applySpeed)

const rotateInput = $<HTMLInputElement>('#rotate')
rotateInput.addEventListener('change', (e) => {
  arena.autoRotate = (e.target as HTMLInputElement).checked
})

/* ---------- view popover ---------- */

// Turn speed and the orbit toggle are the only dock controls that change nothing
// about the match, so they fold away together behind one button. On a phone that
// is the difference between a one-row dock and a two-row one — and the orbit
// toggle, which the compact layout used to hide outright, comes back.
const viewPanel = $('#view-panel')
const viewBtn = $('#btn-view')

function setViewOpen(open: boolean) {
  viewPanel.classList.toggle('hidden', !open)
  viewBtn.setAttribute('aria-expanded', String(open))
}

const closeView = () => setViewOpen(false)

viewBtn.addEventListener('click', (e) => {
  e.stopPropagation()
  setViewOpen(viewPanel.classList.contains('hidden'))
})
// Anywhere outside dismisses it, but a click on the slider itself must not.
viewPanel.addEventListener('click', (e) => e.stopPropagation())
addEventListener('click', closeView)

/* ---------- settings modal ---------- */

function openModal() {
  renderSettings(settings)
  $('#modal').classList.remove('hidden')
}

const closeModal = () => {
  ;(document.activeElement as HTMLElement | null)?.blur()
  $('#modal').classList.add('hidden')
}

$('#btn-settings').addEventListener('click', openModal)
$('#btn-close').addEventListener('click', closeModal)
$('#modal').addEventListener('click', (e) => {
  if (e.target === $('#modal')) closeModal()
})

/* ---------- help modal ---------- */

// Static content, so it only needs showing and hiding — and it deliberately
// does not touch the series, which may well be mid-game behind it.
const closeHelp = () => $('#help-modal').classList.add('hidden')
const openHelp = () => $('#help-modal').classList.remove('hidden')

$('#btn-help').addEventListener('click', openHelp)
$('#btn-help-top').addEventListener('click', openHelp)
$('#btn-help-close').addEventListener('click', closeHelp)
$('#help-modal').addEventListener('click', (e) => {
  if (e.target === $('#help-modal')) closeHelp()
})

/* ---------- escape ---------- */

// Listed in reverse document order. Every modal shares one z-index, so the last
// one in the DOM is the one on top — and only that one closes. A listener per
// modal would instead have a single press dismiss all of them, which is what a
// game ending behind an open Settings dialog used to do.
const MODAL_CLOSERS: [string, () => void][] = [
  ['#help-modal', closeHelp],
  ['#history-modal', () => historyModal.close()],
  ['#leaderboard-modal', () => leaderboard.close()],
  ['#summary-modal', () => summary.close()],
  ['#modal', closeModal],
  // Last: it sits under every modal, so it is only ever the topmost thing open
  // when nothing else is.
  ['#view-panel', closeView],
]

addEventListener('keydown', (e: KeyboardEvent) => {
  if (e.key !== 'Escape') return
  const topmost = MODAL_CLOSERS.find(([sel]) => !$(sel).classList.contains('hidden'))
  if (!topmost) return
  e.preventDefault()
  topmost[1]()
})

$('#btn-save').addEventListener('click', () => {
  Object.assign(settings, readSettings(settings))
  saveSettings(settings)
  hud.setSettings(settings)
  closeModal()
  applySpeed()
  // A live series keeps the config it started with; otherwise pick up the new one.
  // A stalled one counts as live — fixing the key or the model id and hitting
  // Retry is the whole point of parking it there. So does a series being
  // exported: resetting out from under the replay would strand it mid-file.
  if (!exporting && series?.status !== 'running' && series?.status !== 'paused' && series?.status !== 'stalled')
    reset()
})

/* ---------- sharing ---------- */

/** Rendered once per finished series and reused by every share route. Kicked off
 *  as soon as the verdict lands, so a click never waits on the canvas — which
 *  also keeps window.open inside the browser's user-activation window. */
let card: Promise<File | null> | null = null

function buildCard(): Promise<File | null> {
  card ??= renderResultCard(series!, settings, arena.snapshot())
    .then((canvas) => cardFile(canvas, matchFilename(settings, 'png')))
    .catch(() => null)
  return card
}

const fmtMB = (bytes: number) => `${(bytes / 1_048_576).toFixed(1)} MB`
const fmtDuration = (ms: number) => {
  const total = Math.round(ms / 1000)
  return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, '0')}`
}

/** Replays the series' stored PGNs through the arena at Blitz and records the
 *  canvas. See share-video.ts for why the video is a replay rather than a
 *  capture of the match as it was played. */
async function exportVideo() {
  if (exporting) return
  // Every finished game in the book is worth replaying, whether or not the
  // series they belong to ever reached its last round — an abandoned match in
  // History is exactly the sort of thing someone wants the video of.
  if (!series || series.games.length === 0)
    return hud.toast('The video is a replay of finished games — play at least one to the end first.')
  if (!canRecordVideo()) return hud.toast('This browser can’t record the canvas to a video file.')

  const active = series
  const story = buildStoryboard({
    games: active.games,
    names: [settings.players[0].label, settings.players[1].label],
    totalGames: active.totalGames,
    url: shareUrl(settings),
  })
  const anim = paceFor(story.totalPlies, cardMsFor(story.games.length))
  const runtime = estimateMs(story.totalPlies, cardMsFor(story.games.length), anim)

  // The replay has to be the thing on screen, and it starts from move one of
  // game one — so the verdict card comes down and the board goes with it.
  summary.close()
  dismissRotateHint()

  const finalFen = active.chess.fen()
  const controller = new AbortController()
  exporting = true
  setControls()
  arena.speed = anim
  videoProgress.open(() => {
    controller.abort()
    videoProgress.finishing('Cancelling — flushing the encoder…')
  })
  hud.toast(
    runtime > POST_LIMIT_MS
      ? `Replaying the series — about ${fmtDuration(runtime)} of video. That is past X's 2:20 cap; it downloads all the same.`
      : `Replaying the series — about ${fmtDuration(runtime)} of video.`,
  )

  try {
    const blob = await recordSeriesVideo({
      arena,
      storyboard: story,
      anim,
      signal: controller.signal,
      onProgress: ({ fraction, label }) =>
        videoProgress.update(fraction, `${label} — ${Math.round(fraction * 100)}%`),
    })

    if (!blob) {
      hud.toast('Video export cancelled.')
    } else {
      // WebM nearly everywhere, MP4 where that is all the browser records.
      const name = matchFilename(settings, extensionFor(blob.type))
      hud.toast(downloadBlob(blob, name) ? `Saved ${name} — ${fmtMB(blob.size)}.` : 'Could not save the video.')
    }
  } catch (err) {
    hud.toast(`Video export failed — ${err instanceof Error ? err.message : String(err)}`)
  } finally {
    exporting = false
    videoProgress.close()
    // Back to the position the series ended on, whether the replay got there
    // under its own steam or was cancelled halfway through game two.
    arena.setPosition(new Chess(finalFen))
    applySpeed()
    setControls()
  }
}

async function shareImage() {
  const file = await buildCard()
  if (!file) return hud.toast('Could not build the result image.')
  if (await copyImageToClipboard(file)) hud.toast('Result image copied.')
  else if (downloadImage(file)) hud.toast('This browser blocks image copy — saved the card instead.')
  else hud.toast('Could not copy the image.')
}

/** X's post intent takes no media, and chasing that with the share sheet cost
 *  more than it bought. Text and a link it is — the same one step everywhere. */
function postToX() {
  if (!series) return
  const win = open(tweetUrl(postText(series, settings)), '_blank', 'noopener')
  hud.toast(
    win
      ? 'Composer opened — 🖼 Image copies the card if you want it attached.'
      : 'Allow pop-ups to open the X composer.',
  )
}

async function share(action: string) {
  if (!series) return

  if (action === 'result') hud.toast((await copyText(resultText(series, settings))) ? 'Result copied.' : 'Copy failed.')
  else if (action === 'image') await shareImage()
  else if (action === 'video') await exportVideo()
  else if (action === 'link') hud.toast((await copyText(shareUrl(settings))) ? 'Matchup link copied.' : 'Copy failed.')
  else if (action === 'x') postToX()
  else if (action === 'native') await nativeShare(postText(series, settings), shareUrl(settings), await buildCard())
  else if (action === 'submit') {
    // The verdict card owns the submission flow; this is just a shortcut to it.
    summary.close()
    $('#btn-submit-leaderboard').click()
  }
}

for (const row of ['#share', '#summary-share']) {
  $(row).addEventListener('click', (e) => {
    const action = (e.target as HTMLElement).closest<HTMLElement>('[data-share]')?.dataset.share
    if (action) void share(action)
  })
}

$('#btn-defaults').addEventListener('click', () => {
  Object.assign(settings, structuredClone(DEFAULTS), { apiKey: settings.apiKey })
  renderSettings(settings)
})

/* ---------- boot ---------- */

speedInput.value = String(settings.speed)
applySpeed()
arena.autoRotate = rotateInput.checked
if (canNativeShare())
  document.querySelectorAll('[data-share="native"]').forEach((el) => el.classList.remove('hidden'))
if (!canRecordVideo())
  document.querySelectorAll('[data-share="video"]').forEach((el) => el.classList.add('hidden'))
setupMobile()

/** Puts back whatever was on the board when the page last went away.
 *
 *  A shared link outranks it: arriving on `#a=…&b=…` is an explicit request for
 *  that matchup, and silently replacing it with last night's match would make
 *  the link look broken. The saved series is still in History either way. */
function restoreLastMatch(): boolean {
  if (fromLink) return false
  const id = history.currentId
  const snap = id ? history.get(id) : null
  if (!snap) return false
  loadSnapshot(snap)
  return true
}

if (restoreLastMatch()) {
  hud.toast(
    series!.resumable
      ? 'Picked your match back up where it left off — press Resume to carry on.'
      : 'Restored your last match. 🕘 History has the rest.',
  )
} else {
  reset()
}
if (firstVisit || fromLink) openModal()
