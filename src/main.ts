import './style.css'
import { Arena } from './three/arena'
import { material, MAX_MATERIAL, Series, type GameRecord, type PlayerStats } from './series'
import { loadSettings, saveSettings, isFirstVisit, DEFAULTS, SPEEDS, effectiveSpeedIndex, type Settings } from './settings'
import { Hud } from './ui/hud'
import { readSettings, renderSettings } from './ui/settings-ui'
import { applyMatchHash, canNativeShare, canShareFile, copyText, fmtScore, nativeShare, resultText, shareUrl, tweetUrl } from './share'
import { cardFile, copyImageToClipboard, downloadImage, renderResultCard } from './share-image'
import { dismissRotateHint, setupMobile } from './ui/mobile'
import { SummaryModal, type SummaryRow, type SummaryView } from './ui/summary'
import { Leaderboard } from './leaderboard'

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
let series: Series | null = null
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
    },
    onMove: (e) => arena.animateMove(e.move, series!.chess, { check: e.check, mate: e.mate }),
    onGameEnd: async (rec) => {
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
    },
  })
}

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
  $<HTMLButtonElement>('#btn-run').disabled = running
  $<HTMLButtonElement>('#btn-pause').disabled = !running
  $('#btn-pause').textContent = stalled ? '↻ Retry' : series?.status === 'paused' ? '▶ Resume' : '❚❚ Pause'
  $('#btn-pause').classList.toggle('primary', stalled)
}

/* ---------- controls ---------- */

$('#btn-run').addEventListener('click', async () => {
  const needsKey = settings.players.some((p) => p.model.trim().toLowerCase() !== 'random')
  if (needsKey && !settings.apiKey) {
    hud.toast('Add an API key in Settings, or set a model to "random" to watch a demo match.')
    openModal()
    return
  }
  dismissRotateHint()
  hud.clearLog()
  card = null
  series = newSeries()
  const leaderboardRun = leaderboard.prepare(settings)
  arena.setPosition(series.chess)
  hud.render(series)
  const finished = series.run()
  setControls()
  await finished
  if (series.status === 'error') hud.toast(series.errorMessage)
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
})

$('#btn-pause').addEventListener('click', () => {
  if (!series) return
  if (series.status === 'stalled') series.retry()
  else series.status === 'paused' ? series.resume() : series.pause()
  setControls()
  syncStatus()
})

function reset() {
  series?.stop()
  // Frees whatever round is parked on the countdown before the series is swapped.
  summary.close()
  card = null
  leaderboard.clear()
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
  arena.speed = s.anim
  $('#speed-label').textContent = effectiveIndex === settings.speed ? s.label : `${s.label} demo`
  saveSettings(settings)
}
speedInput.addEventListener('input', applySpeed)

const rotateInput = $<HTMLInputElement>('#rotate')
rotateInput.addEventListener('change', (e) => {
  arena.autoRotate = (e.target as HTMLInputElement).checked
})

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

$('#btn-save').addEventListener('click', () => {
  Object.assign(settings, readSettings(settings))
  saveSettings(settings)
  hud.setSettings(settings)
  closeModal()
  applySpeed()
  // A live series keeps the config it started with; otherwise pick up the new one.
  // A stalled one counts as live — fixing the key or the model id and hitting
  // Retry is the whole point of parking it there.
  if (series?.status !== 'running' && series?.status !== 'paused' && series?.status !== 'stalled') reset()
})

/* ---------- sharing ---------- */

const slug = (s: string) => s.trim().toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'player'

/** Rendered once per finished series and reused by every share route. Kicked off
 *  as soon as the verdict lands, so a click never waits on the canvas — which
 *  also keeps window.open inside the browser's user-activation window. */
let card: Promise<File | null> | null = null

function buildCard(): Promise<File | null> {
  card ??= renderResultCard(series!, settings, arena.snapshot())
    .then((canvas) =>
      cardFile(canvas, `grand-tensor-${slug(settings.players[0].label)}-vs-${slug(settings.players[1].label)}.png`),
    )
    .catch(() => null)
  return card
}

async function shareImage() {
  const file = await buildCard()
  if (!file) return hud.toast('Could not build the result image.')
  if (await copyImageToClipboard(file)) hud.toast('Result image copied.')
  else if (downloadImage(file)) hud.toast('This browser blocks image copy — saved the card instead.')
  else hud.toast('Could not copy the image.')
}

/** X's post intent takes no media — there is no URL parameter for it, and their
 *  media upload needs OAuth. So the card rides along one of two ways: the
 *  platform share sheet where that carries files, or the clipboard everywhere
 *  else, with the composer opened ready for a paste. */
async function postToX(text: string) {
  const file = await buildCard()

  if (file && canShareFile(file)) {
    hud.toast('Pick X in the share sheet to post with the card attached.')
    return nativeShare(text, shareUrl(settings), file)
  }

  const copied = file ? await copyImageToClipboard(file) : false
  const win = open(tweetUrl(text), '_blank', 'noopener')
  if (!win) return hud.toast(copied ? 'Card copied — allow pop-ups to open the composer.' : 'Allow pop-ups to open the composer.')
  hud.toast(
    copied
      ? 'Composer opened — paste (⌘V / Ctrl+V) to attach the card. X can’t take it from a link.'
      : 'Composer opened. Use ⧉ Image to copy the card, then paste it into the post.',
  )
}

async function share(action: string) {
  if (!series) return
  const text = resultText(series, settings)

  if (action === 'result') hud.toast((await copyText(text)) ? 'Result copied.' : 'Copy failed.')
  else if (action === 'image') await shareImage()
  else if (action === 'link') hud.toast((await copyText(shareUrl(settings))) ? 'Matchup link copied.' : 'Copy failed.')
  else if (action === 'x') await postToX(text)
  else if (action === 'native') await nativeShare(text, shareUrl(settings), await buildCard())
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
setupMobile()
reset()
if (firstVisit || fromLink) openModal()
