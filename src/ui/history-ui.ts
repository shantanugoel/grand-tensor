/** The match history modal: every series this browser has played, and what can
 *  still be done with it.
 *
 *  Deliberately not a table. A row here is a match card — matchup, scoreline,
 *  the same pips the HUD draws — because the thing being chosen between is a
 *  game you watched, not a number you are comparing. Every action routes back
 *  through `main.ts`, which loads the series into the arena first; there is no
 *  second, headless path to the video and the card, so what history exports and
 *  what the live match exports cannot drift. */

import { gamesPlayed, isComplete, leaderOf, scoreOf, type SeriesSnapshot } from '../history'
import { fmtScore } from '../share'

const $ = <T extends HTMLElement = HTMLElement>(sel: string) => document.querySelector(sel) as T

export type HistoryAction = 'open' | 'resume' | 'result' | 'image' | 'video' | 'delete'

export type HistoryHandlers = {
  list: () => SeriesSnapshot[]
  /** The series the arena is showing, if it is one of them. */
  currentId: () => string | null
  /** Whether that series is playing right now — it has nothing to resume. */
  isPlaying: () => boolean
  /** Whether this browser can record a match video at all. */
  canRecordVideo: boolean
  act: (action: HistoryAction, id: string) => void
  clearAll: () => void
}

const dateFmt = new Intl.DateTimeFormat(undefined, {
  month: 'short',
  day: 'numeric',
  hour: '2-digit',
  minute: '2-digit',
})

const fmtCost = (n: number) => (n > 0 ? `$${n < 0.01 ? n.toFixed(4) : n.toFixed(2)}` : null)

export class HistoryModal {
  private el = $('#history-modal')
  private listEl = $('#history-list')
  private clearBtn = $<HTMLButtonElement>('#btn-history-clear')
  /** Ids waiting on a second click to confirm. Held here rather than in the DOM
   *  so a re-render doesn't quietly arm or disarm a delete. */
  private confirming = new Set<string>()

  constructor(private handlers: HistoryHandlers) {
    $('#btn-history-close').addEventListener('click', () => this.close())
    this.el.addEventListener('click', (e) => {
      if (e.target === this.el) this.close()
    })
    this.clearBtn.addEventListener('click', () => {
      if (!this.confirming.has('*')) {
        this.confirming.add('*')
        this.render()
        return
      }
      this.handlers.clearAll()
      this.close()
    })
    // Escape is handled once, in main.ts, so a single press closes only the
    // modal on top rather than every modal at once.
  }

  get isOpen() {
    return !this.el.classList.contains('hidden')
  }

  open() {
    this.confirming.clear()
    this.render()
    this.el.classList.remove('hidden')
  }

  close() {
    ;(document.activeElement as HTMLElement | null)?.blur()
    this.confirming.clear()
    this.el.classList.add('hidden')
  }

  /** Redraws if the modal is on screen; a no-op otherwise. */
  refresh() {
    if (this.isOpen) this.render()
  }

  private render() {
    const entries = this.handlers.list()
    this.clearBtn.classList.toggle('hidden', entries.length === 0)
    this.clearBtn.textContent = this.confirming.has('*') ? 'Delete everything?' : 'Clear history'
    this.clearBtn.classList.toggle('danger', this.confirming.has('*'))

    if (!entries.length) {
      const empty = document.createElement('p')
      empty.className = 'modal-empty'
      empty.textContent =
        'No matches yet. Every series you start is saved here — including the one in progress, so a reload picks it straight back up.'
      this.listEl.replaceChildren(empty)
      return
    }

    this.listEl.replaceChildren(...entries.map((snap) => this.card(snap)))
  }

  private card(snap: SeriesSnapshot): HTMLElement {
    const current = this.handlers.currentId() === snap.id
    const playing = current && this.handlers.isPlaying()
    const complete = isComplete(snap)
    const played = gamesPlayed(snap)
    const [a, b] = scoreOf(snap)
    const leader = leaderOf(snap)

    const card = document.createElement('article')
    card.className = current ? 'history-card current' : 'history-card'

    /* head: when, how long, and where it got to */
    const head = document.createElement('div')
    head.className = 'history-head'
    const when = document.createElement('span')
    when.className = 'history-when'
    when.textContent = dateFmt.format(new Date(snap.startedAt))
    const badge = document.createElement('span')
    badge.className = complete && !playing ? 'history-badge done' : 'history-badge'
    badge.textContent = playing
      ? 'PLAYING NOW'
      : complete
        ? current
          ? 'ON SCREEN · COMPLETE'
          : 'COMPLETE'
        : current
          ? 'ON SCREEN · UNFINISHED'
          : 'UNFINISHED'
    head.append(when, badge)

    /* the matchup */
    const line = document.createElement('div')
    line.className = 'history-matchup'
    const nameA = document.createElement('span')
    nameA.className = leader === 0 ? 'history-name p0 lead' : 'history-name p0'
    nameA.textContent = snap.settings.players[0].label
    const score = document.createElement('b')
    score.className = 'history-score'
    score.textContent = `${fmtScore(a)} – ${fmtScore(b)}`
    const nameB = document.createElement('span')
    nameB.className = leader === 1 ? 'history-name p1 lead' : 'history-name p1'
    nameB.textContent = snap.settings.players[1].label
    line.append(nameA, score, nameB)

    /* one pip per game, the same alphabet the HUD uses */
    const pips = document.createElement('div')
    pips.className = 'pips history-pips'
    for (let i = 0; i < snap.settings.games; i++) {
      const pip = document.createElement('i')
      pip.className = 'pip'
      const rec = snap.games[i]
      if (rec) {
        const winner = rec.result === '1/2-1/2' ? null : rec.result === '1-0' ? rec.white : 1 - rec.white
        pip.classList.add(winner === null ? 'draw' : winner === 0 ? 'w0' : 'w1')
        pip.title = `Game ${i + 1}: ${rec.result} — ${rec.reason}`
      } else {
        pip.title = `Game ${i + 1}: not played`
      }
      pips.appendChild(pip)
    }

    const moves = (snap.stats[0]?.moves ?? 0) + (snap.stats[1]?.moves ?? 0)
    const cost = fmtCost((snap.stats[0]?.usage.cost ?? 0) + (snap.stats[1]?.usage.cost ?? 0))
    const meta = document.createElement('div')
    meta.className = 'history-meta'
    meta.textContent = [
      `${played} of ${snap.settings.games} games`,
      `${moves} moves`,
      ...(cost ? [cost] : []),
    ].join(' · ')

    const stats = document.createElement('div')
    stats.className = 'history-stats'
    stats.append(pips, meta)

    card.append(head, line, stats, this.actions(snap, { current, playing, complete, played }))
    return card
  }

  private actions(
    snap: SeriesSnapshot,
    state: { current: boolean; playing: boolean; complete: boolean; played: number },
  ) {
    const row = document.createElement('div')
    row.className = 'history-actions'

    const add = (label: string, action: HistoryAction, title: string, enabled = true) => {
      const btn = document.createElement('button')
      btn.className = 'btn tiny'
      btn.textContent = label
      btn.title = title
      btn.disabled = !enabled
      btn.addEventListener('click', () => this.handlers.act(action, snap.id))
      row.appendChild(btn)
      return btn
    }

    // The match already playing needs neither: it is on the board, and it is
    // going. Opening or resuming it would only interrupt it.
    if (!state.current) add('↺ Open', 'open', 'Put this match back on the board')
    if (!state.complete && !state.playing) {
      const resume = add('▶ Resume', 'resume', `Carry on from game ${state.played + 1}`)
      resume.classList.add('primary')
    }
    add('⧉ Result', 'result', 'Copy the scoreline and stats', state.played > 0)
    add('🖼 Image', 'image', 'Copy the result card as an image', state.played > 0)
    if (this.handlers.canRecordVideo)
      add('🎬 Video', 'video', 'Replay the games and save a video file', state.played > 0)

    // Two clicks, because there is no undo behind this one.
    const del = document.createElement('button')
    del.className = 'btn tiny danger'
    const paint = () => (del.textContent = this.confirming.has(snap.id) ? 'Delete?' : '🗑')
    del.title = 'Delete this match'
    paint()
    del.addEventListener('click', () => {
      if (!this.confirming.has(snap.id)) {
        this.confirming.add(snap.id)
        paint()
        return
      }
      this.handlers.act('delete', snap.id)
    })
    row.appendChild(del)

    return row
  }
}
