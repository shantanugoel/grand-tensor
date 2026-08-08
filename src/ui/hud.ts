/** Everything that writes to the DOM overlay: player cards, score, battle log. */

import { material, MAX_MATERIAL } from '../adjudication'
import { type LogEntry, type PlayerIdx, type Series } from '../series'
import { NO_EFFORT, type Settings } from '../settings'

const $ = <T extends HTMLElement = HTMLElement>(sel: string) => document.querySelector(sel) as T

const fmtTokens = (n: number) => (n >= 10000 ? `${(n / 1000).toFixed(1)}k` : n.toLocaleString())
const fmtCost = (n: number) => (n > 0 ? `$${n < 0.01 ? n.toFixed(5) : n.toFixed(4)}` : '—')
const fmtMs = (n: number) => (n >= 1000 ? `${(n / 1000).toFixed(1)}s` : `${Math.round(n)}ms`)


/** Battle-log lines held in the DOM, and mirrored for the saved match. */
const LOG_LIMIT = 300

export class Hud {
  private cards: HTMLElement[] = []
  private logEl = $('#log')
  /** The same lines the log is showing, kept in order so a match can be saved
   *  with its commentary and read back exactly as it was. */
  private entries: LogEntry[] = []
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
        <div class="player-model">
          <span class="model-id">${escapeHtml(p.model)}</span>
          <span class="model-effort" data-effort title="Reasoning effort">${escapeHtml(p.effort)}</span>
        </div>
        <div class="player-score" data-score>0</div>
        <div class="stat-grid">
          <span>W/D/L <b data-wdl>0/0/0</b></span>
          <span>Moves <b data-moves>0</b></span>
          <span>Tokens <b data-tokens>0</b></span>
          <span>Reasoning <b data-reason>0</b></span>
          <span>Illegal <b data-illegal>0</b></span>
          <span data-capped-row hidden>Capped <b data-capped>0</b></span>
          <span>Cost <b data-cost>—</b></span>
          <span>Last <b data-latency>—</b></span>
          <span>Avg <b data-avg>—</b></span>
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
      const isWhite = i === white
      side.innerHTML = isWhite ? '<span aria-hidden="true">♖</span> WHITE' : 'BLACK <span aria-hidden="true">♜</span>'
      side.classList.toggle('is-white', isWhite)
      side.classList.toggle('is-black', !isWhite)
      side.title = `${this.settings.players[i].label} is playing ${isWhite ? 'white' : 'black'}`
      // Configured effort until the series has vetted it against the model, then
      // whatever is actually going out on the wire.
      const wanted = this.settings.players[i].effort
      const effort = series.resolvedEffort?.[i] ?? wanted
      const effortEl = q('effort')
      effortEl.textContent = effort
      effortEl.classList.toggle('is-default', effort === NO_EFFORT)
      effortEl.title =
        effort === wanted ? 'Reasoning effort' : `"${wanted}" isn't supported here — using the provider default`

      q('score').textContent = String(st.score)
      q('wdl').textContent = `${st.wins}/${st.draws}/${st.losses}`
      q('moves').textContent = String(st.moves)
      q('tokens').textContent = fmtTokens(st.usage.total)
      q('reason').textContent = fmtTokens(st.usage.reasoning)
      q('illegal').textContent = String(st.illegal)
      // Kept out of the way until it happens — the grid is two columns wide and
      // most matches never hit the cap at all.
      q('capped-row').hidden = st.capped === 0
      q('capped').textContent = String(st.capped)
      q('cost').textContent = fmtCost(st.usage.cost)
      q('latency').textContent = st.lastMs ? fmtMs(st.lastMs) : '—'
      q('avg').textContent = st.turns ? fmtMs(st.totalMs / st.turns) : '—'
      const say = q('say')
      const isThinking = this.thinking === i
      say.className = isThinking ? 'say thinking-dots' : 'say'
      say.textContent = isThinking ? 'thinking' : series.lastSay[i as PlayerIdx] || ''
    })

    // Two different scopes used to sit in two places without saying so: the card
    // read the live game while the player stats above it ran series-wide.
    $('#s-ply').textContent = `Game ${series.chess.history().length} · Series ${a.moves + b.moves}`
    $('#s-cost').textContent = fmtCost(a.usage.cost + b.usage.cost)

    this.renderKoMeter(series)

    // One pip per game in the series: who won, or grey for a draw / not played yet.
    const pips = Array.from({ length: series.totalGames }, (_, i) => {
      const pip = document.createElement('i')
      pip.className = 'pip'
      pip.title = `Game ${i + 1}`

      const rec = series.games[i]
      if (!rec) return pip

      const winner = rec.result === '1/2-1/2' ? null : rec.result === '1-0' ? rec.white : 1 - rec.white
      const cls = winner === null ? 'draw' : winner === 0 ? 'w0' : 'w1'
      pip.classList.add(cls)
      pip.title = `Game ${i + 1}: ${rec.result} — ${rec.reason}`
      return pip
    })
    $('#pips').replaceChildren(...pips)

    const done = series.status === 'done'
    $('#result-card').classList.toggle('hidden', !done)
    if (done) {
      const champ = $('#champion')
      const leader = series.leader
      champ.textContent =
        leader === null
          ? `SERIES DRAWN ${a.score}-${b.score}`
          : `CHAMPION: ${this.settings.players[leader].label} ${a.score} : ${b.score}`
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

      const side = $(`#ko-side-${i}`)
      const isWhite = i === white
      side.innerHTML = isWhite ? '<span aria-hidden="true">♖</span> WHITE' : 'BLACK <span aria-hidden="true">♜</span>'
      side.classList.toggle('is-white', isWhite)
      side.classList.toggle('is-black', !isWhite)
      side.title = `${this.settings.players[i].label} is playing ${isWhite ? 'white' : 'black'}`

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

  get logEntries(): LogEntry[] {
    return this.entries
  }

  /** Repopulates the log from a saved match, oldest line first. */
  restoreLog(entries: LogEntry[]) {
    this.clearLog()
    for (const entry of entries) this.log(entry)
  }

  log(entry: LogEntry) {
    this.entries.push(entry)
    while (this.entries.length > LOG_LIMIT) this.entries.shift()

    const li = document.createElement('li')
    const cls = entry.kind === 'move' ? (entry.player === 0 ? 'p0' : 'p1') : entry.kind
    li.className = cls
    const label =
      entry.kind === 'move' ? `<b>${escapeHtml(entry.text)}</b>` : escapeHtml(entry.text)
    li.innerHTML = entry.detail
      ? `${label}<span class="detail">${escapeHtml(entry.detail)}</span>`
      : label
    this.logEl.appendChild(li)
    while (this.logEl.childElementCount > LOG_LIMIT) this.logEl.removeChild(this.logEl.firstChild!)
    this.logEl.scrollTop = this.logEl.scrollHeight
  }

  clearLog() {
    this.entries = []
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
