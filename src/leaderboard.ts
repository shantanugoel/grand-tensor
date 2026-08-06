import {
  CIRCUITS,
  DEFAULT_CIRCUIT,
  LEADERBOARD_API,
  LEADERBOARD_APP_VERSION,
  protocolConfig,
  submissionReason,
  type Circuit,
  type LeaderboardSubmission,
  type ProtocolConfig,
  type Standing,
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
const DELETION_KEY = 'grand-tensor:leaderboard-deletions'
const $ = <T extends HTMLElement = HTMLElement>(selector: string) => document.querySelector(selector) as T

function installationId() {
  const existing = localStorage.getItem(INSTALLATION_KEY)
  if (existing) return existing
  const id = crypto.randomUUID()
  localStorage.setItem(INSTALLATION_KEY, id)
  return id
}

async function api<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(`${LEADERBOARD_API}${path}`, {
    ...init,
    headers: { 'Content-Type': 'application/json', ...init?.headers },
  })
  const body = (await response.json().catch(() => ({}))) as { error?: string } & T
  if (!response.ok) throw new Error(body.error || `Leaderboard request failed (${response.status}).`)
  return body
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

export class Leaderboard {
  private prepared: PreparedRun | null = null
  private completed: { series: Series; prepared: PreparedRun } | null = null
  private configPromise: Promise<LeaderboardConfig> | null = null
  private widgetId: string | null = null
  private standingsCircuit: Circuit = DEFAULT_CIRCUIT

  constructor(private toast: (message: string) => void) {
    $('#btn-leaderboard').addEventListener('click', () => void this.openStandings())
    $('#btn-submit-leaderboard').addEventListener('click', () => void this.openSubmission())
    $('#btn-leaderboard-close').addEventListener('click', () => this.close())
    $('#leaderboard-modal').addEventListener('click', (event) => {
      if (event.target === $('#leaderboard-modal')) this.close()
    })
    this.setSubmitState(false, 'Finish an eligible ranked match to submit it.')
  }

  async prepare(settings: Settings): Promise<PreparedRun> {
    this.completed = null
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
    this.completed = { series, prepared }
    const ready = Boolean(prepared.config && prepared.ticket)
    this.setSubmitState(
      ready,
      prepared.reason ?? `Submit this anonymous result to the ${prepared.circuit?.name ?? 'leaderboard'}.`,
    )
  }

  clear() {
    this.prepared = null
    this.completed = null
    this.setSubmitState(false, 'Finish an eligible ranked match to submit it.')
  }

  private setSubmitState(enabled: boolean, title: string) {
    const button = $<HTMLButtonElement>('#btn-submit-leaderboard')
    button.disabled = !enabled
    button.title = title
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
      const result = await api<{
        windowDays: number
        disclosure: string
        standings: Standing[]
      }>(`/v1/standings?circuit=${encodeURIComponent(circuit.id)}`)
      // A slow response for a tab the user has since left must not overwrite the
      // one they're actually looking at.
      if (this.standingsCircuit.id !== circuit.id) return
      body.replaceChildren()

      const note = document.createElement('p')
      note.className = 'leaderboard-note'
      note.textContent = `${circuit.blurb} ${result.disclosure} Results cover the last ${result.windowDays} days.`
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
        '<thead><tr><th>#</th><th>Model</th><th>Score</th><th>W/D/L</th><th>Games</th></tr></thead>'
      const tbody = document.createElement('tbody')
      for (const row of result.standings) {
        const tr = document.createElement('tr')
        const values = [
          String(row.rank),
          row.model,
          `${row.scorePct.toFixed(1)}% (${fmtPoints(row.points)})`,
          `${row.wins}/${row.draws}/${row.losses}`,
          String(row.games),
        ]
        for (const value of values) {
          const td = document.createElement('td')
          td.textContent = value
          tr.appendChild(td)
        }
        tbody.appendChild(tr)
      }
      table.appendChild(tbody)
      wrap.appendChild(table)
      body.appendChild(wrap)
    } catch (error) {
      if (this.standingsCircuit.id !== circuit.id) return
      loading.textContent = error instanceof Error ? error.message : 'Could not load standings.'
      loading.classList.add('error')
    }
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
    const completed = this.completed
    if (!completed?.prepared.config || !completed.prepared.ticket || !completed.prepared.circuit) {
      this.toast(completed?.prepared.reason ?? 'This match is not eligible for ranked standings.')
      return
    }
    const circuit = completed.prepared.circuit

    this.open(`Submit to the ${circuit.name}`)
    const content = $('#leaderboard-content')
    const intro = document.createElement('p')
    intro.className = 'leaderboard-note'
    intro.textContent =
      `This is optional. Grand Tensor uploads exact model IDs, ${circuit.name} settings, results and PGNs. It never uploads API keys, player labels, prompts, commentary, token usage, latency or cost.`
    const matchup = document.createElement('div')
    matchup.className = 'leaderboard-matchup'
    matchup.textContent = `${completed.prepared.config.players[0].model}  ${completed.series.stats[0].score}–${completed.series.stats[1].score}  ${completed.prepared.config.players[1].model}`
    const disclosure = document.createElement('p')
    disclosure.className = 'leaderboard-note'
    disclosure.textContent =
      'The server replays every PGN and checks the board result. Because model calls happen in your browser, the model identity remains community-reported.'
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
            ticket: completed.prepared.ticket!,
            turnstileToken: token,
            config: completed.prepared.config!,
            games: this.gamesForSubmission(completed.series),
          }
          const result = await api<{ id: string; deleteToken: string; message: string }>('/v1/submissions', {
            method: 'POST',
            body: JSON.stringify(payload),
          })
          this.rememberDeletion(result.id, result.deleteToken)
          this.setSubmitState(false, 'This result has been submitted.')
          this.close()
          this.toast(result.message)
        } catch (error) {
          this.toast(error instanceof Error ? error.message : 'Submission failed.')
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

  private rememberDeletion(id: string, token: string) {
    try {
      const saved = JSON.parse(localStorage.getItem(DELETION_KEY) ?? '[]') as { id: string; token: string }[]
      saved.push({ id, token })
      localStorage.setItem(DELETION_KEY, JSON.stringify(saved.slice(-100)))
    } catch {
      localStorage.setItem(DELETION_KEY, JSON.stringify([{ id, token }]))
    }
  }
}
