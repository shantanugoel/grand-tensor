/** The between-rounds and end-of-series summary modal.
 *
 *  Two shapes, one shell. Between games it is a scoreboard with a 3-2-1
 *  countdown that the series awaits before dealing the next round; at the end of
 *  the series it is the same scoreboard, dismissable, with the share row. */

const $ = <T extends HTMLElement = HTMLElement>(sel: string) => document.querySelector(sel) as T

export type SummaryRow = {
  label: string
  a: string
  b: string
  /** Renders in the accent of whoever came out ahead on this line. */
  lead?: 0 | 1 | null
}

export type SummaryView = {
  /** Modal heading, e.g. "Game 2 of 6". */
  title: string
  /** Arcade verdict line, e.g. "WHITE WINS". */
  headline: string
  headlineKind: 'p0' | 'p1' | 'draw'
  /** How it ended, e.g. "checkmate · 41 moves". */
  detail: string
  names: [string, string]
  score: [string, string]
  /** Caption under the score, e.g. "Series score". */
  scoreLabel: string
  rows: SummaryRow[]
}

export class SummaryModal {
  private el = $('#summary-modal')
  private contentEl = $('#summary-content')
  private countdownEl = $('#summary-countdown')
  private countEl = $('#summary-count')
  private shareEl = $('#summary-share')
  private closeBtn = $('#btn-summary-close')
  private skipBtn = $('#btn-summary-skip')

  /** Resolves the promise the series is parked on. Null when nothing waits. */
  private release: (() => void) | null = null
  private ticker: ReturnType<typeof setInterval> | undefined

  constructor() {
    this.closeBtn.addEventListener('click', () => this.close())
    this.skipBtn.addEventListener('click', () => this.close())
    this.el.addEventListener('click', (e) => {
      // Backdrop click dismisses the final card; between rounds it skips ahead.
      if (e.target === this.el) this.close()
    })
    // Escape is deliberately not handled here. Every modal shares one z-index,
    // so a listener per modal would have one press dismiss all of them at once —
    // a game ending behind an open Settings dialog closed both. main.ts owns the
    // single handler and closes only the topmost.
  }

  get isOpen() {
    return !this.el.classList.contains('hidden')
  }

  /** Between rounds: shows the card, counts down, resolves when it clears.
   *  Resolves early if the viewer skips or the series is reset. */
  interstitial(view: SummaryView, seconds: number): Promise<void> {
    this.render(view)
    this.shareEl.classList.add('hidden')
    this.closeBtn.classList.add('hidden')
    this.skipBtn.classList.remove('hidden')
    this.countdownEl.classList.remove('hidden')
    this.el.classList.remove('hidden')

    let left = seconds
    this.tickCount(left)
    return new Promise<void>((resolve) => {
      this.release = resolve
      this.ticker = setInterval(() => {
        left -= 1
        if (left <= 0) return this.close()
        this.tickCount(left)
      }, 1000)
    })
  }

  /** End of series: the same card, dismissable, with the share row. */
  final(view: SummaryView) {
    this.render(view)
    this.countdownEl.classList.add('hidden')
    this.skipBtn.classList.add('hidden')
    this.closeBtn.classList.remove('hidden')
    this.shareEl.classList.remove('hidden')
    this.el.classList.remove('hidden')
  }

  close() {
    clearInterval(this.ticker)
    this.ticker = undefined
    ;(document.activeElement as HTMLElement | null)?.blur()
    this.el.classList.add('hidden')
    const release = this.release
    this.release = null
    release?.()
  }

  private tickCount(n: number) {
    // Restart the pop animation on every number.
    this.countEl.textContent = ''
    void this.countEl.offsetWidth
    this.countEl.textContent = String(n)
  }

  private render(view: SummaryView) {
    $('#summary-title').textContent = view.title

    const rows = view.rows
      .map(
        (r) => `
        <div class="summary-row">
          <b class="summary-a${r.lead === 0 ? ' lead' : ''}">${escapeHtml(r.a)}</b>
          <span>${escapeHtml(r.label)}</span>
          <b class="summary-b${r.lead === 1 ? ' lead' : ''}">${escapeHtml(r.b)}</b>
        </div>`,
      )
      .join('')

    this.contentEl.innerHTML = `
      <div class="summary-verdict ${view.headlineKind}">${escapeHtml(view.headline)}</div>
      <div class="summary-detail">${escapeHtml(view.detail)}</div>
      <div class="summary-scoreline">
        <span class="summary-name p0">${escapeHtml(view.names[0])}</span>
        <b class="summary-score">${escapeHtml(view.score[0])} – ${escapeHtml(view.score[1])}</b>
        <span class="summary-name p1">${escapeHtml(view.names[1])}</span>
      </div>
      <div class="summary-score-label">${escapeHtml(view.scoreLabel)}</div>
      <div class="summary-rows">${rows}</div>`
  }
}

function escapeHtml(s: string) {
  return s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`)
}
