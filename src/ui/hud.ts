/** Everything that writes to the DOM overlay: player cards, score, battle log. */

import { material, MAX_MATERIAL, type LogEntry, type PlayerIdx, type Series } from '../series'
import type { Settings } from '../settings'

const $ = <T extends HTMLElement = HTMLElement>(sel: string) => document.querySelector(sel) as T

const fmtTokens = (n: number) => (n >= 10000 ? `${(n / 1000).toFixed(1)}k` : n.toLocaleString())
const fmtCost = (n: number) => (n > 0 ? `$${n < 0.01 ? n.toFixed(5) : n.toFixed(4)}` : '—')
const fmtMs = (n: number) => (n >= 1000 ? `${(n / 1000).toFixed(1)}s` : `${Math.round(n)}ms`)


export class Hud {
  private cards: HTMLElement[] = []
  private logEl = $('#log')
  private thinking: PlayerIdx | null = null
  private toastTimer: ReturnType<typeof setTimeout> | undefined
  private announceTimer: ReturnType<typeof setTimeout> | undefined

  constructor(private settings: Settings) {
    this.buildCards()
  }

  setSettings(s: Settings) {
    this.settings = s
    this.buildCards()
  }

  private buildCards() {
    const host = $('#player-cards')
    host.innerHTML = ''
    this.cards = this.settings.players.map((p, i) => {
      const el = document.createElement('article')
      el.className = 'player'
      el.style.setProperty('--accent', i === 0 ? 'var(--p0)' : 'var(--p1)')
      el.innerHTML = `
        <div class="player-head">
          <div class="player-name">${escapeHtml(p.label)}</div>
          <div class="player-side" data-side>—</div>
        </div>
        <div class="player-model">${escapeHtml(p.model)}</div>
        <div class="player-score" data-score>0</div>
        <div class="stat-grid">
          <span>W/D/L <b data-wdl>0/0/0</b></span>
          <span>Moves <b data-moves>0</b></span>
          <span>Tokens <b data-tokens>0</b></span>
          <span>Reasoning <b data-reason>0</b></span>
          <span>Illegal <b data-illegal>0</b></span>
          <span>Last <b data-latency>—</b></span>
        </div>
        <div class="say" data-say></div>`
      host.appendChild(el)
      return el
    })
  }

  setThinking(player: PlayerIdx | null) {
    this.thinking = player
    this.cards.forEach((c, i) => c.classList.toggle('thinking', i === player))
  }

  setStatus(text: string, kind: 'idle' | 'live' | 'err' = 'idle') {
    const chip = $('#status-chip')
    chip.textContent = text
    chip.className = `chip ${kind === 'idle' ? '' : kind}`
  }

  render(series: Series) {
    const [a, b] = series.stats
    const white = series.white

    series.stats.forEach((st, i) => {
      const card = this.cards[i]
      if (!card) return
      const q = <T extends HTMLElement = HTMLElement>(k: string) => card.querySelector(`[data-${k}]`) as T
      const side = q('side')
      side.textContent = i === white ? 'WHITE' : 'BLACK'
      side.classList.toggle('is-white', i === white)
      q('score').textContent = String(st.score)
      q('wdl').textContent = `${st.wins}/${st.draws}/${st.losses}`
      q('moves').textContent = String(st.moves)
      q('tokens').textContent = fmtTokens(st.usage.total)
      q('reason').textContent = fmtTokens(st.usage.reasoning)
      q('illegal').textContent = String(st.illegal)
      q('latency').textContent = st.lastMs ? fmtMs(st.lastMs) : '—'
      const say = q('say')
      const isThinking = this.thinking === i
      say.className = isThinking ? 'say thinking-dots' : 'say'
      say.textContent = isThinking ? 'thinking' : series.lastSay[i as PlayerIdx] || ''
    })

    $('#s-ply').textContent = String(series.chess.history().length)
    $('#s-cost').textContent = fmtCost(a.usage.cost + b.usage.cost)

    this.renderKoMeter(series)

    // One pip per game in the series: who won, or grey for a draw / not played yet.
    $('#pips').innerHTML = Array.from({ length: series.totalGames }, (_, i) => {
      const rec = series.games[i]
      if (!rec) return `<i class="pip" title="Game ${i + 1}"></i>`
      const winner = rec.result === '1/2-1/2' ? null : rec.result === '1-0' ? rec.white : 1 - rec.white
      const cls = winner === null ? 'draw' : winner === 0 ? 'w0' : 'w1'
      return `<i class="pip ${cls}" title="Game ${i + 1}: ${rec.result} — ${rec.reason}"></i>`
    }).join('')

    const champ = $('#champion')
    if (series.status === 'done') {
      const leader = series.leader
      champ.classList.remove('hidden')
      champ.textContent =
        leader === null
          ? `SERIES DRAWN ${a.score}-${b.score}`
          : `CHAMPION: ${this.settings.players[leader].label} ${a.score} : ${b.score}`
    } else {
      champ.classList.add('hidden')
    }
  }

  /** Vitality bars, round counter and win stars — the arcade header. */
  private renderKoMeter(series: Series) {
    const white = series.white

    series.stats.forEach((st, i) => {
      const color = i === white ? 'w' : 'b'
      const hp = material(series.chess, color)
      const pct = (hp / MAX_MATERIAL) * 100

      $(`#ko-name-${i}`).textContent = this.settings.players[i].label
      $(`#ko-hp-${i}`).textContent = String(hp)
      $(`#ko-fill-${i}`).style.width = `${pct}%`
      $(`#ko-chip-${i}`).style.width = `${pct}%`
      $(`#ko-fill-${i}`).parentElement!.classList.toggle('danger', pct < 25)

      // Half-stars keep drawn games visible rather than rounding them away.
      const full = Math.floor(st.score)
      const half = st.score % 1 !== 0
      $(`#ko-stars-${i}`).innerHTML = Array.from({ length: series.totalGames }, (_, n) =>
        n < full ? '<i class="star won"></i>' : n === full && half ? '<i class="star half"></i>' : '<i class="star"></i>',
      ).join('')
    })

    const idle = series.status === 'idle' && series.games.length === 0
    $('#ko-round').textContent = idle
      ? `BEST OF ${series.totalGames}`
      : `ROUND ${Math.min(series.gameIndex + 1, series.totalGames)} OF ${series.totalGames}`
    $('#ko-score').textContent = `${series.stats[0].score}–${series.stats[1].score}`
  }

  /** Big arcade slam text. Auto-clears when the animation ends. */
  announce(text: string) {
    const el = $('#announce')
    const span = el.querySelector('span')!
    el.classList.remove('hidden')
    // Re-trigger the CSS animation on repeat announcements.
    span.textContent = ''
    void span.offsetWidth
    span.textContent = text
    clearTimeout(this.announceTimer)
    this.announceTimer = setTimeout(() => el.classList.add('hidden'), 2000)
  }

  log(entry: LogEntry) {
    const li = document.createElement('li')
    const cls = entry.kind === 'move' ? (entry.player === 0 ? 'p0' : 'p1') : entry.kind
    li.className = cls
    const label =
      entry.kind === 'move' ? `<b>${escapeHtml(entry.text)}</b>` : escapeHtml(entry.text)
    li.innerHTML = entry.detail
      ? `${label}<span class="detail">${escapeHtml(entry.detail)}</span>`
      : label
    this.logEl.appendChild(li)
    while (this.logEl.childElementCount > 300) this.logEl.removeChild(this.logEl.firstChild!)
    this.logEl.scrollTop = this.logEl.scrollHeight
  }

  clearLog() {
    this.logEl.innerHTML = ''
  }

  toast(message: string) {
    const el = $('#toast')
    el.textContent = message
    el.classList.remove('hidden')
    clearTimeout(this.toastTimer)
    this.toastTimer = setTimeout(() => el.classList.add('hidden'), 7000)
  }
}

function escapeHtml(s: string) {
  return s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`)
}
