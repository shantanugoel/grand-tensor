import './style.css'
import { Arena } from './three/arena'
import { Series } from './series'
import { loadSettings, saveSettings, isFirstVisit, DEFAULTS, SPEEDS, type Settings } from './settings'
import { Hud } from './ui/hud'
import { readSettings, renderSettings } from './ui/settings-ui'

const $ = <T extends HTMLElement = HTMLElement>(sel: string) => document.querySelector(sel) as T

const firstVisit = isFirstVisit()
const settings: Settings = loadSettings()
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
      const banner = rec.result === '1/2-1/2' ? 'DRAW' : rec.result === '1-0' ? 'WHITE WINS' : 'BLACK WINS'
      arena.announce(banner, rec.result === '1/2-1/2' ? '#8fa5d6' : '#ffd54a')
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

$('#btn-defaults').addEventListener('click', () => {
  Object.assign(settings, structuredClone(DEFAULTS), { apiKey: settings.apiKey })
  renderSettings(settings)
})

/* ---------- boot ---------- */

speedInput.value = String(settings.speed)
applySpeed()
reset()
if (firstVisit) openModal()
