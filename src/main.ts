import './style.css'
import { Arena } from './three/arena'
import { material, MAX_MATERIAL, Series } from './series'
import { loadSettings, saveSettings, isFirstVisit, DEFAULTS, SPEEDS, type Settings } from './settings'
import { Hud } from './ui/hud'
import { readSettings, renderSettings } from './ui/settings-ui'
import { applyMatchHash, canNativeShare, copyText, nativeShare, resultText, shareUrl, tweetUrl } from './share'

const $ = <T extends HTMLElement = HTMLElement>(sel: string) => document.querySelector(sel) as T

const firstVisit = isFirstVisit()
const settings: Settings = loadSettings()
// A shared link carries the matchup but never a key, so it overrides the models
// and then still needs the visitor's own credentials.
const fromLink = applyMatchHash(settings)
const arena = new Arena($('#stage'))
const hud = new Hud(settings)
let series: Series | null = null

function newSeries(): Series {
  return new Series(settings, {
    onGameStart: (index, white) => {
      arena.setPosition(series!.chess)
      hud.log({ kind: 'info', text: `Game ${index + 1} — ${settings.players[white].label} has white` })
      hud.render(series!)
    },
    onMove: (e) => arena.animateMove(e.move, series!.chess, { check: e.check, mate: e.mate }),
    onGameEnd: (rec) => {
      if (rec.result === '1/2-1/2') {
        arena.announce('DRAW', '#8fa5d6')
        hud.announce('DRAW')
        return
      }
      arena.announce(rec.result === '1-0' ? 'WHITE WINS' : 'BLACK WINS', '#ffd54a')
      // Winning without conceding a single piece earns the arcade "PERFECT".
      const winnerColor = rec.result === '1-0' ? 'w' : 'b'
      hud.announce(material(series!.chess, winnerColor) === MAX_MATERIAL ? 'PERFECT' : 'K.O.')
    },
    onThinking: (player) => {
      hud.setThinking(player)
      hud.render(series!)
    },
    onLog: (entry) => hud.log(entry),
    onUpdate: () => {
      hud.render(series!)
      syncStatus()
    },
  })
}

function syncStatus() {
  if (!series) return hud.setStatus('IDLE')
  switch (series.status) {
    case 'running':
      return hud.setStatus(`GAME ${series.gameIndex + 1}/${series.totalGames} LIVE`, 'live')
    case 'paused':
      return hud.setStatus('PAUSED')
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
  const running = series?.status === 'running' || series?.status === 'paused'
  $<HTMLButtonElement>('#btn-run').disabled = running
  $<HTMLButtonElement>('#btn-pause').disabled = !running
  $('#btn-pause').textContent = series?.status === 'paused' ? '▶ Resume' : '❚❚ Pause'
}

/* ---------- controls ---------- */

$('#btn-run').addEventListener('click', async () => {
  const needsKey = settings.players.some((p) => p.model.trim().toLowerCase() !== 'random')
  if (needsKey && !settings.apiKey) {
    hud.toast('Add an API key in Settings, or set a model to "random" to watch a demo match.')
    openModal()
    return
  }
  hud.clearLog()
  series = newSeries()
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
    const leader = series.leader
    setTimeout(() => hud.announce(leader === null ? 'DRAW MATCH' : 'CHAMPION'), 1500)
  }
})

$('#btn-pause').addEventListener('click', () => {
  if (!series) return
  series.status === 'paused' ? series.resume() : series.pause()
  setControls()
  syncStatus()
})

function reset() {
  series?.stop()
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
  const s = SPEEDS[settings.speed] ?? SPEEDS[3]
  arena.speed = s.anim
  $('#speed-label').textContent = s.label
  saveSettings(settings)
}
speedInput.addEventListener('input', applySpeed)

$<HTMLInputElement>('#rotate').addEventListener('change', (e) => {
  arena.autoRotate = (e.target as HTMLInputElement).checked
})

/* ---------- settings modal ---------- */

function openModal() {
  renderSettings(settings)
  $('#modal').classList.remove('hidden')
}

const closeModal = () => $('#modal').classList.add('hidden')

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
  // A live series keeps the config it started with; otherwise pick up the new one.
  if (series?.status !== 'running' && series?.status !== 'paused') reset()
})

/* ---------- sharing ---------- */

$('#share').addEventListener('click', async (e) => {
  const action = (e.target as HTMLElement).closest<HTMLElement>('[data-share]')?.dataset.share
  if (!series || !action) return
  const text = resultText(series, settings)

  if (action === 'result') hud.toast((await copyText(text)) ? 'Result copied.' : 'Copy failed.')
  else if (action === 'link') hud.toast((await copyText(shareUrl(settings))) ? 'Matchup link copied.' : 'Copy failed.')
  else if (action === 'x') open(tweetUrl(text), '_blank', 'noopener')
  else if (action === 'native') await nativeShare(text, shareUrl(settings))
})

$('#btn-defaults').addEventListener('click', () => {
  Object.assign(settings, structuredClone(DEFAULTS), { apiKey: settings.apiKey })
  renderSettings(settings)
})

/* ---------- boot ---------- */

speedInput.value = String(settings.speed)
applySpeed()
if (canNativeShare()) $('[data-share="native"]').classList.remove('hidden')
reset()
if (firstVisit || fromLink) openModal()
