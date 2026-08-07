import {
  circuitFor,
  CIRCUITS,
  DEFAULT_CIRCUIT,
  LEADERBOARD_API,
  LEADERBOARD_APP_VERSION,
  LEADERBOARD_WINDOW_DAYS,
  protocolConfig,
  submissionReason,
  type Circuit,
  type EntrantResponse,
  type LeaderboardSubmission,
  type ProtocolConfig,
  type Standing,
  type StandingsResponse,
  type SubmittedGame,
} from './leaderboard-protocol'
import type { Series } from './series'
import type { Settings } from './settings'

type PreparedRun = {
  config?: ProtocolConfig
  circuit?: Circuit
  ticket?: string
  reason?: string
}

/** A finished ranked result that has not been sent yet.
 *
 *  It outlives the page, because the run it describes usually outlives the
 *  person watching it: a ten-game series finishes into an empty room, and the
 *  browser gets closed, or reloaded, or the laptop sleeps for a day. Nothing
 *  here needs the live `Series` — the games are already reduced to what the
 *  submission actually sends, so what is stored is the request, minus the
 *  Turnstile token that has to be solved fresh each time. */
type PendingSubmission = {
  version: 1
  ticket: string
  config: ProtocolConfig
  games: SubmittedGame[]
  /** Series score, kept only so the confirmation dialog can show the matchup
   *  without the `Series` object that produced it. */
  score: [number, number]
}

type LeaderboardConfig = {
  siteKey: string
  circuits: Circuit[]
}

type TurnstileApi = {
  render: (
    container: HTMLElement,
    options: {
      sitekey: string
      action: string
      theme: 'dark'
      appearance: 'interaction-only'
      callback: (token: string) => void
      'expired-callback': () => void
      'error-callback': () => void
    },
  ) => string
  reset: (widgetId: string) => void
}

declare global {
  interface Window {
    turnstile?: TurnstileApi
  }
}

const INSTALLATION_KEY = 'grand-tensor:leaderboard-installation'
const PENDING_KEY = 'grand-tensor:pending-submission'
/** Withdrawal is gone, so the tokens saved under this key can never be spent.
 *  Cleared on load rather than left behind, since they were only ever secrets. */
const LEGACY_DELETION_KEY = 'grand-tensor:leaderboard-deletions'
const $ = <T extends HTMLElement = HTMLElement>(selector: string) => document.querySelector(selector) as T

function installationId() {
  const existing = localStorage.getItem(INSTALLATION_KEY)
  if (existing) return existing
  const id = crypto.randomUUID()
  localStorage.setItem(INSTALLATION_KEY, id)
  return id
}

/** Carries the server's refusal `code` as well as its prose, because whether a
 *  saved result is kept or dropped turns on which refusal it was. */
class ApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly code?: string,
  ) {
    super(message)
  }
}

async function api<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(`${LEADERBOARD_API}${path}`, {
    ...init,
    headers: { 'Content-Type': 'application/json', ...init?.headers },
  })
  const body = (await response.json().catch(() => ({}))) as { error?: string; code?: string } & T
  if (!response.ok)
    throw new ApiError(body.error || `Leaderboard request failed (${response.status}).`, response.status, body.code)
  return body
}

/** The two refusals a saved result can never recover from: the window it belongs
 *  to has closed, or the board already has it. Everything else — a failed
 *  challenge, a quota, a service having a bad afternoon — is worth holding on
 *  to, so the result stays put and the button stays live. */
const isTerminalRefusal = (error: unknown) =>
  error instanceof ApiError && (error.code === 'stale' || error.code === 'duplicate')

/** Reads the issue time out of the app's own run ticket. The payload half is
 *  base64url JSON and is not a secret — the signature is what makes the ticket
 *  worth anything, and only the server can check that. This is used solely to
 *  stop offering a result the server is bound to refuse as stale; anything
 *  unreadable is left alone and allowed to fail honestly at the server. */
function ticketIssuedAt(ticket: string): number | null {
  try {
    const encoded = ticket.split('.')[0]
    const padded = encoded.replace(/-/g, '+').replace(/_/g, '/') + '='.repeat((4 - (encoded.length % 4)) % 4)
    const issuedAt = (JSON.parse(atob(padded)) as { issuedAt?: unknown }).issuedAt
    return typeof issuedAt === 'number' && Number.isFinite(issuedAt) ? issuedAt : null
  } catch {
    return null
  }
}

function isPending(value: unknown): value is PendingSubmission {
  const pending = value as PendingSubmission | null
  return (
    !!pending &&
    pending.version === 1 &&
    typeof pending.ticket === 'string' &&
    Array.isArray(pending.games) &&
    pending.games.length > 0 &&
    Array.isArray(pending.score) &&
    pending.score.length === 2 &&
    !!pending.config &&
    Array.isArray(pending.config.players) &&
    pending.config.players.length === 2 &&
    circuitFor(pending.config.maxTokens) !== null
  )
}

/** Anything that fails to parse, fails to typecheck, or has aged past the
 *  standings window is dropped here rather than kept and refused later. */
function loadPending(): PendingSubmission | null {
  let stored: string | null = null
  try {
    stored = localStorage.getItem(PENDING_KEY)
  } catch {
    return null
  }
  if (!stored) return null

  let parsed: unknown
  try {
    parsed = JSON.parse(stored)
  } catch {
    parsed = null
  }
  if (!isPending(parsed)) {
    dropPending()
    return null
  }

  const issuedAt = ticketIssuedAt(parsed.ticket)
  if (issuedAt !== null && issuedAt < Date.now() - LEADERBOARD_WINDOW_DAYS * 24 * 60 * 60 * 1000) {
    dropPending()
    return null
  }
  return parsed
}

function savePending(pending: PendingSubmission) {
  try {
    localStorage.setItem(PENDING_KEY, JSON.stringify(pending))
  } catch {
    // A full or disabled store costs the user the ability to submit after a
    // reload, and nothing else. The in-memory result still works this session.
  }
}

function dropPending() {
  try {
    localStorage.removeItem(PENDING_KEY)
  } catch {
    /* nothing to do — the entry is unreachable either way */
  }
}

let turnstileLoading: Promise<TurnstileApi> | null = null

function loadTurnstile(): Promise<TurnstileApi> {
  if (window.turnstile) return Promise.resolve(window.turnstile)
  if (turnstileLoading) return turnstileLoading
  turnstileLoading = new Promise((resolve, reject) => {
    const script = document.createElement('script')
    script.src = 'https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit'
    script.async = true
    script.defer = true
    script.addEventListener('load', () =>
      window.turnstile ? resolve(window.turnstile) : reject(new Error('Turnstile did not initialize.')),
    )
    script.addEventListener('error', () => reject(new Error('Anti-bot verification could not load.')))
    document.head.appendChild(script)
  })
  return turnstileLoading
}

function fmtPoints(points: number) {
  return Number.isInteger(points) ? String(points) : `${Math.floor(points)}½`
}

/** `default` means no effort parameter was sent at all, which is a real entrant
 *  but not a claim about how hard the model thought — so it reads muted. */
function effortChip(effort: string) {
  const chip = document.createElement('span')
  chip.className = effort === 'default' ? 'effort-chip muted' : 'effort-chip'
  chip.textContent = effort
  return chip
}

function cell(row: HTMLTableRowElement, value: string | Node, className?: string) {
  const td = document.createElement('td')
  if (className) td.className = className
  typeof value === 'string' ? (td.textContent = value) : td.appendChild(value)
  row.appendChild(td)
  return td
}

export class Leaderboard {
  private prepared: PreparedRun | null = null
  /** The result the Submit button offers, restored from storage on load. There
   *  is one slot: a finished ranked match replaces whatever it held, and only
   *  submitting it — or the server saying it can never be taken — empties it. */
  private pending: PendingSubmission | null = null
  /** Why the *last finished* match could not be submitted, shown when there is
   *  nothing pending to offer instead. */
  private ineligibleReason: string | null = null
  private configPromise: Promise<LeaderboardConfig> | null = null
  private widgetId: string | null = null
  private standingsCircuit: Circuit = DEFAULT_CIRCUIT

  constructor(private toast: (message: string) => void) {
    localStorage.removeItem(LEGACY_DELETION_KEY)
    $('#btn-leaderboard').addEventListener('click', () => void this.openStandings())
    $('#btn-submit-leaderboard').addEventListener('click', () => void this.openSubmission())
    $('#btn-pending-submit').addEventListener('click', () => void this.openSubmission())
    $('#btn-leaderboard-close').addEventListener('click', () => this.close())
    $('#leaderboard-modal').addEventListener('click', (event) => {
      if (event.target === $('#leaderboard-modal')) this.close()
    })
    this.pending = loadPending()
    this.refreshSubmitState()
  }

  async prepare(settings: Settings): Promise<PreparedRun> {
    // A match in progress hides the button rather than clearing what is behind
    // it: abandoning a run should not cost the result of the one before it.
    this.setSubmitState(false, 'Match in progress.')
    const eligibility = await protocolConfig(settings)
    if (!eligibility.config || !eligibility.circuit) {
      this.prepared = { reason: eligibility.reason }
      return this.prepared
    }

    const circuit = eligibility.circuit
    try {
      const result = await api<{ ticket: string; protocol: string }>('/v1/run-ticket', {
        method: 'POST',
        body: JSON.stringify(eligibility.config),
      })
      this.prepared =
        result.protocol === circuit.id
          ? { config: eligibility.config, circuit, ticket: result.ticket }
          : { reason: 'The leaderboard protocol is temporarily incompatible with this version.' }
    } catch (error) {
      this.prepared = {
        reason: error instanceof Error ? error.message : 'The leaderboard service is unavailable.',
      }
    }
    return this.prepared
  }

  complete(series: Series, prepared: PreparedRun) {
    if (series.status !== 'done') return
    this.ineligibleReason = prepared.reason ?? null

    if (prepared.config && prepared.ticket) {
      try {
        this.pending = {
          version: 1,
          ticket: prepared.ticket,
          config: prepared.config,
          games: this.gamesForSubmission(series),
          score: [series.stats[0].score, series.stats[1].score],
        }
        savePending(this.pending)
      } catch (error) {
        // An ending the protocol has no name for. The match is unsubmittable,
        // but whatever was already pending is still good and still offered.
        this.ineligibleReason = error instanceof Error ? error.message : 'This match cannot be submitted.'
      }
    }
    this.refreshSubmitState()
  }

  /** Called when the board is reset. Deliberately not a reset of the pending
   *  result: clearing the arena is about the next match, not a decision to throw
   *  away the last one. */
  idle() {
    this.prepared = null
    this.ineligibleReason = null
    this.refreshSubmitState()
  }

  private refreshSubmitState() {
    if (this.pending) {
      const circuit = circuitFor(this.pending.config.maxTokens)
      return this.setSubmitState(
        true,
        `Submit your last ${circuit?.name ?? 'ranked'} result. It is saved here until you do.`,
      )
    }
    this.setSubmitState(false, this.ineligibleReason ?? 'Finish an eligible ranked match to submit it.')
  }

  private setSubmitState(enabled: boolean, title: string) {
    const button = $<HTMLButtonElement>('#btn-submit-leaderboard')
    button.disabled = !enabled
    button.title = title

    // The topbar copy is shown only when there is genuinely something saved to
    // send, so it reads as a reminder rather than as another piece of chrome.
    const waiting = $<HTMLButtonElement>('#btn-pending-submit')
    waiting.classList.toggle('hidden', !this.pending)
    waiting.title = title
  }

  private leaderboardConfig() {
    this.configPromise ??= api<LeaderboardConfig>('/v1/config')
    return this.configPromise
  }

  private open(title: string) {
    $('#leaderboard-title').textContent = title
    $('#leaderboard-content').replaceChildren()
    $('#leaderboard-modal').classList.remove('hidden')
  }

  private close() {
    ;(document.activeElement as HTMLElement | null)?.blur()
    $('#leaderboard-modal').classList.add('hidden')
  }

  /** Each circuit is its own ranking, so the modal is a tab per circuit over a
   *  shared body rather than one merged table. */
  private async openStandings() {
    this.open('Standings')
    const content = $('#leaderboard-content')

    const tabs = document.createElement('div')
    tabs.className = 'circuit-tabs'
    const body = document.createElement('div')
    content.append(tabs, body)

    const buttons = CIRCUITS.map((circuit) => {
      const tab = document.createElement('button')
      tab.className = 'circuit-tab'
      tab.textContent = circuit.name
      tab.title = circuit.blurb
      tab.addEventListener('click', () => void select(circuit))
      tabs.appendChild(tab)
      return tab
    })

    const select = async (circuit: Circuit) => {
      this.standingsCircuit = circuit
      buttons.forEach((tab, i) => tab.classList.toggle('active', CIRCUITS[i].id === circuit.id))
      await this.renderStandings(body, circuit)
    }

    await select(this.standingsCircuit)
  }

  private async renderStandings(body: HTMLElement, circuit: Circuit) {
    body.replaceChildren()
    const loading = document.createElement('p')
    loading.className = 'leaderboard-note'
    loading.textContent = 'Loading community standings…'
    body.appendChild(loading)

    try {
      const result = await api<StandingsResponse>(`/v1/standings?circuit=${encodeURIComponent(circuit.id)}`)
      // A slow response for a tab the user has since left must not overwrite the
      // one they're actually looking at.
      if (this.standingsCircuit.id !== circuit.id) return
      body.replaceChildren()

      const note = document.createElement('p')
      note.className = 'leaderboard-note'
      note.textContent =
        `${circuit.blurb} Rating is a Bradley-Terry fit over every result in the window, so beating a strong entrant counts for more than beating a weak one. ` +
        `Entrants with fewer than ${result.minOpponents} distinct opponents are listed but unranked. ` +
        `${result.disclosure} Results cover the last ${result.windowDays} days.`
      body.appendChild(note)

      if (!result.standings.length) {
        const empty = document.createElement('p')
        empty.className = 'leaderboard-empty'
        empty.textContent = `No ${circuit.name} results yet. The first legal submission will inaugurate the board.`
        body.appendChild(empty)
        return
      }

      const wrap = document.createElement('div')
      wrap.className = 'leaderboard-table-wrap'
      const table = document.createElement('table')
      table.className = 'leaderboard-table'
      table.innerHTML =
        '<thead><tr><th>#</th><th>Model</th><th>Effort</th><th>Rating</th><th>Score</th><th>W/D/L</th><th>Opp.</th><th>Games</th></tr></thead>'
      const tbody = document.createElement('tbody')
      for (const row of result.standings) tbody.appendChild(this.standingRow(row, circuit))
      table.appendChild(tbody)
      wrap.appendChild(table)
      body.appendChild(wrap)
    } catch (error) {
      if (this.standingsCircuit.id !== circuit.id) return
      loading.textContent = error instanceof Error ? error.message : 'Could not load standings.'
      loading.classList.add('error')
    }
  }

  private standingRow(row: Standing, circuit: Circuit) {
    const tr = document.createElement('tr')
    tr.className = row.provisional ? 'standing-row provisional' : 'standing-row'
    tr.tabIndex = 0
    tr.title = row.provisional
      ? `${row.opponents} distinct opponent${row.opponents === 1 ? '' : 's'} so far — too few to rank. Open the record.`
      : 'Open this entrant’s record'

    cell(tr, row.rank === null ? '—' : String(row.rank))
    cell(tr, row.model)
    cell(tr, effortChip(row.effort))
    cell(tr, row.provisional ? '—' : `${row.rating} ±${row.ratingMargin}`)
    cell(tr, `${row.scorePct.toFixed(1)}% (${fmtPoints(row.points)})`)
    cell(tr, `${row.wins}/${row.draws}/${row.losses}`)
    cell(tr, String(row.opponents))
    cell(tr, String(row.games))

    const open = () => void this.openEntrant(circuit, row.model, row.effort)
    tr.addEventListener('click', open)
    tr.addEventListener('keydown', (event) => {
      if (event.key === 'Enter' || event.key === ' ') {
        event.preventDefault()
        open()
      }
    })
    return tr
  }

  /** The record behind a rating: who this entrant actually played, and how often.
   *  Farming one weak opponent is invisible in a single number and obvious here. */
  private async openEntrant(circuit: Circuit, model: string, effort: string) {
    this.open(`${model} · ${effort}`)
    const content = $('#leaderboard-content')
    const loading = document.createElement('p')
    loading.className = 'leaderboard-note'
    loading.textContent = 'Loading match record…'
    content.appendChild(loading)

    const back = document.createElement('button')
    back.className = 'btn ghost tiny'
    back.textContent = '← Standings'
    back.addEventListener('click', () => void this.openStandings())

    try {
      const query = new URLSearchParams({ circuit: circuit.id, model, effort })
      const record = await api<EntrantResponse>(`/v1/entrant?${query}`)
      content.replaceChildren(back)

      const summary = document.createElement('p')
      summary.className = 'leaderboard-note'
      summary.textContent =
        `${record.circuit.name} · ${record.series} series, ${record.games} games · ` +
        `${record.wins}/${record.draws}/${record.losses} · ${record.scorePct.toFixed(1)}% overall.`
      content.appendChild(summary)

      const heading = document.createElement('h3')
      heading.className = 'leaderboard-subhead'
      heading.textContent = 'Head to head'
      content.appendChild(heading)

      const wrap = document.createElement('div')
      wrap.className = 'leaderboard-table-wrap'
      const table = document.createElement('table')
      table.className = 'leaderboard-table'
      table.innerHTML =
        '<thead><tr><th>Opponent</th><th>Effort</th><th>Score</th><th>W/D/L</th><th>Series</th><th>Games</th></tr></thead>'
      const tbody = document.createElement('tbody')
      for (const opponent of record.headToHead) {
        const tr = document.createElement('tr')
        cell(tr, opponent.model)
        cell(tr, effortChip(opponent.effort))
        cell(tr, `${opponent.scorePct.toFixed(1)}%`)
        cell(tr, `${opponent.wins}/${opponent.draws}/${opponent.losses}`)
        cell(tr, String(opponent.series))
        cell(tr, String(opponent.games))
        tbody.appendChild(tr)
      }
      table.appendChild(tbody)
      wrap.appendChild(table)
      content.appendChild(wrap)
    } catch (error) {
      content.replaceChildren(back)
      const failed = document.createElement('p')
      failed.className = 'leaderboard-note error'
      failed.textContent = error instanceof Error ? error.message : 'Could not load this record.'
      content.appendChild(failed)
    }
  }

  /** Forgets the saved result for good, in memory and on disk, and leaves the
   *  button explaining what happened to it. */
  private discardPending(note: string) {
    this.pending = null
    dropPending()
    this.ineligibleReason = note
    this.refreshSubmitState()
  }

  private gamesForSubmission(series: Series): SubmittedGame[] {
    return series.games.map((game) => {
      const reason = submissionReason(game.reason)
      if (!reason) throw new Error(`Game ${game.index + 1} has an unsupported ending reason.`)
      return {
        index: game.index,
        white: game.white,
        result: game.result,
        reason,
        plies: game.plies,
        pgn: game.pgn,
      }
    })
  }

  private async openSubmission() {
    const pending = this.pending
    const circuit = pending && circuitFor(pending.config.maxTokens)
    if (!pending || !circuit) {
      this.toast(this.ineligibleReason ?? 'This match is not eligible for ranked standings.')
      return
    }

    this.open(`Submit to the ${circuit.name}`)
    const content = $('#leaderboard-content')
    const intro = document.createElement('p')
    intro.className = 'leaderboard-note'
    intro.textContent =
      `This is optional. Grand Tensor uploads exact model IDs, ${circuit.name} settings, results and PGNs. It never uploads API keys, player labels, prompts, commentary, token usage, latency or cost.`
    const matchup = document.createElement('div')
    matchup.className = 'leaderboard-matchup'
    matchup.textContent = `${pending.config.players[0].model}  ${fmtPoints(pending.score[0])}–${fmtPoints(pending.score[1])}  ${pending.config.players[1].model}`
    const disclosure = document.createElement('p')
    disclosure.className = 'leaderboard-note'
    disclosure.textContent =
      'The server replays every PGN and checks the board result. Because model calls happen in your browser, the model identity remains community-reported. A submitted result is final and cannot be withdrawn. It is dated to when the match was played rather than to now, and it is kept on this device until you send it — so there is no hurry, and no advantage in waiting.'
    const widget = document.createElement('div')
    widget.className = 'turnstile-host'
    const actions = document.createElement('div')
    actions.className = 'modal-foot leaderboard-actions'
    const cancel = document.createElement('button')
    cancel.className = 'btn ghost'
    cancel.textContent = 'Cancel'
    cancel.addEventListener('click', () => this.close())
    const submit = document.createElement('button')
    submit.className = 'btn primary'
    submit.textContent = 'Verify to submit'
    submit.disabled = true
    actions.append(cancel, submit)
    content.append(intro, matchup, disclosure, widget, actions)

    try {
      const [turnstile, config] = await Promise.all([loadTurnstile(), this.leaderboardConfig()])
      if (!config.circuits.some((known) => known.id === circuit.id && known.maxTokens === circuit.maxTokens))
        throw new Error('Leaderboard protocol mismatch.')
      let token = ''
      this.widgetId = turnstile.render(widget, {
        sitekey: config.siteKey,
        action: 'leaderboard_submit',
        theme: 'dark',
        appearance: 'interaction-only',
        callback: (value) => {
          token = value
          submit.disabled = false
          submit.textContent = 'Submit anonymous result'
        },
        'expired-callback': () => {
          token = ''
          submit.disabled = true
          submit.textContent = 'Verify to submit'
        },
        'error-callback': () => {
          token = ''
          submit.disabled = true
          submit.textContent = 'Verification failed'
        },
      })

      submit.addEventListener('click', async () => {
        if (!token) return
        submit.disabled = true
        submit.textContent = 'Submitting…'
        try {
          const payload: LeaderboardSubmission = {
            schemaVersion: 1,
            appVersion: LEADERBOARD_APP_VERSION,
            protocol: circuit.id,
            installationId: installationId(),
            ticket: pending.ticket,
            turnstileToken: token,
            config: pending.config,
            games: pending.games,
          }
          const result = await api<{ id: string; message: string }>('/v1/submissions', {
            method: 'POST',
            body: JSON.stringify(payload),
          })
          this.discardPending('This result has been submitted.')
          this.close()
          this.toast(result.message)
        } catch (error) {
          // Only a refusal that can never be retried takes the result away. A
          // quota, a failed challenge or a service outage leaves it saved, so
          // the button is still there tomorrow.
          const message = error instanceof Error ? error.message : 'Submission failed.'
          if (isTerminalRefusal(error)) {
            this.discardPending(message)
            this.close()
            this.toast(message)
            return
          }
          this.toast(message)
          token = ''
          submit.textContent = 'Verify to retry'
          turnstile.reset(this.widgetId!)
        }
      })
    } catch (error) {
      disclosure.textContent = error instanceof Error ? error.message : 'Anti-bot verification is unavailable.'
      disclosure.classList.add('error')
    }
  }

}
