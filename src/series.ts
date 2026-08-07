/** Runs a series of model-vs-model games and keeps the score.
 *  Pure logic + events: it knows nothing about three.js or the DOM. */

import { Chess, type Move } from 'chess.js'
import { adjudicate, adjudicationReason } from './adjudication'
import { addUsage, chat, ChatError, emptyUsage, fetchModels, type ChatResult, type ModelInfo, type Usage } from './llm'
import { capRetryPrompt, cleanPgn, movePrompt, parseMove, retryPrompt, systemPrompt, type LegalMove } from './prompt'
import { NO_EFFORT, normalizeReasoningEffort, REASONING_OFF, SPEEDS, type PlayerConfig, type Settings } from './settings'

export type PlayerIdx = 0 | 1

export type PlayerStats = {
  wins: number
  draws: number
  losses: number
  score: number
  moves: number
  /** Replies that named a move the position doesn't allow, or named none at all. */
  illegal: number
  /** Replies that ran out of completion budget before a move appeared. Kept apart
   *  from `illegal` because it measures budget discipline, not chess. */
  capped: number
  usage: Usage
  /** API round trips, including the ones spent retrying an illegal move. */
  calls: number
  /** Move requests that produced a move — the denominator for the average. */
  turns: number
  /** Wall time spent thinking, summed over turns. Retries are part of a turn,
   *  so this is what the "thinking" indicator has actually been up for. */
  totalMs: number
  lastMs: number
}

export type GameRecord = {
  index: number
  white: PlayerIdx
  result: '1-0' | '0-1' | '1/2-1/2'
  reason: string
  plies: number
  pgn: string
}

export type LogEntry = {
  kind: 'move' | 'info' | 'warn' | 'error'
  player?: PlayerIdx
  text: string
  detail?: string
}

export type MoveEvent = {
  player: PlayerIdx
  move: Move
  say: string
  ms: number
  ply: number
  check: boolean
  mate: boolean
}

export type SeriesEvents = {
  /** Awaited, so the board animation finishes before the next request goes out. */
  onMove: (e: MoveEvent) => Promise<void> | void
  onGameStart: (gameIndex: number, white: PlayerIdx) => Promise<void> | void
  onGameEnd: (rec: GameRecord) => Promise<void> | void
  onThinking: (player: PlayerIdx | null) => void
  onLog: (entry: LogEntry) => void
  /** Generic "something changed, redraw the HUD". */
  onUpdate: () => void
}

const newStats = (): PlayerStats => ({
  wins: 0,
  draws: 0,
  losses: 0,
  score: 0,
  moves: 0,
  illegal: 0,
  capped: 0,
  usage: emptyUsage(),
  calls: 0,
  turns: 0,
  totalMs: 0,
  lastMs: 0,
})

export type Status = 'idle' | 'running' | 'paused' | 'stalled' | 'done' | 'error'

/** Backoff between connection retries: 2s, 4s, 8s… up to a minute. The ceiling
 *  matters more than the growth — an unattended series should keep knocking on
 *  a provider that is down, not drift out to hour-long gaps. */
const RETRY_BASE_MS = 2000
const RETRY_MAX_MS = 60_000

/** Jittered so two browsers riding out the same outage don't sync up on it. */
const backoffMs = (tries: number) =>
  Math.round(Math.min(RETRY_BASE_MS * 2 ** tries, RETRY_MAX_MS) * (0.75 + Math.random() * 0.5))

/** Why a player ran out of attempts. Spelled the way the game record reads it. */
export type ForfeitCause = 'illegal moves' | 'token cap'

/** A completed turn, or the reason the player couldn't produce one. */
type TurnOutcome = { san: string; say: string; ms: number } | { forfeit: ForfeitCause }

export class Series {
  chess = new Chess()
  status: Status = 'idle'
  stats: [PlayerStats, PlayerStats] = [newStats(), newStats()]
  games: GameRecord[] = []
  gameIndex = 0
  white: PlayerIdx = 0
  lastSay: [string, string] = ['', '']
  errorMessage = ''

  /** Per-player effort after checking it against the model, or null until the
   *  series has run that check — the HUD falls back to the configured value. */
  resolvedEffort: [string, string] | null = null

  private abort = new AbortController()
  private resumeWaiters: (() => void)[] = []
  /** Resolved with true by `retry()`, false if the series is abandoned. */
  private stallWaiters: ((go: boolean) => void)[] = []
  /** What the endpoint says about each model: pricing and supported efforts. */
  private models = new Map<string, ModelInfo>()
  private effort: [string, string] = [NO_EFFORT, NO_EFFORT]

  constructor(private settings: Settings, private events: SeriesEvents) {}

  get totalGames() {
    return this.settings.games
  }

  /** Score is 1 / 0.5 / 0 per game; the higher total takes the crown. */
  get leader(): PlayerIdx | null {
    const [a, b] = this.stats
    if (a.score === b.score) return null
    return a.score > b.score ? 0 : 1
  }

  pause() {
    if (this.status === 'running') {
      this.status = 'paused'
      this.events.onUpdate()
    }
  }

  resume() {
    if (this.status === 'paused') {
      this.status = 'running'
      this.resumeWaiters.splice(0).forEach((fn) => fn())
      this.events.onUpdate()
    }
  }

  /** Re-issues the request a stalled series is parked on. The position, the
   *  score and the pending conversation never went anywhere, so play picks up
   *  on the same move rather than restarting the series. */
  retry() {
    if (this.status !== 'stalled') return
    this.status = 'running'
    this.errorMessage = ''
    this.stallWaiters.splice(0).forEach((fn) => fn(true))
    this.events.onUpdate()
  }

  stop() {
    this.abort.abort()
    this.resumeWaiters.splice(0).forEach((fn) => fn())
    this.stallWaiters.splice(0).forEach((fn) => fn(false))
  }

  async run() {
    this.status = 'running'
    this.events.onLog({ kind: 'info', text: `Series started — best of ${this.settings.games}` })
    this.models = await fetchModels(this.settings.baseUrl, this.settings.apiKey)
    this.effort = this.settings.players.map((p, i) => this.resolveEffort(p, i as PlayerIdx)) as [string, string]
    this.resolvedEffort = this.effort
    this.events.onUpdate()
    try {
      for (this.gameIndex = 0; this.gameIndex < this.settings.games; this.gameIndex++) {
        this.white = (this.gameIndex % 2) as PlayerIdx
        await this.playGame()
        if (this.abort.signal.aborted) break
      }
      if (!this.abort.signal.aborted) {
        this.status = 'done'
        const leader = this.leader
        this.events.onLog({
          kind: 'info',
          text:
            leader === null
              ? `Series drawn ${this.stats[0].score}–${this.stats[1].score}`
              : `${this.settings.players[leader].label} takes the crown ${this.stats[0].score}–${this.stats[1].score}`,
        })
      } else {
        this.status = 'idle'
      }
    } catch (err) {
      this.status = 'error'
      this.errorMessage = err instanceof Error ? err.message : String(err)
      this.events.onLog({ kind: 'error', text: 'Series halted', detail: this.errorMessage })
    }
    this.events.onThinking(null)
    this.events.onUpdate()
  }

  private black(): PlayerIdx {
    return (1 - this.white) as PlayerIdx
  }

  /** Settings can outlive a model's capabilities — a shared link, or a model
   *  that dropped an effort level. Rather than let the request 400, fall back to
   *  the provider default and say so once, up front. */
  private resolveEffort(cfg: PlayerConfig, player: PlayerIdx): string {
    const requested = normalizeReasoningEffort(cfg.effort)
    if (requested === NO_EFFORT) return NO_EFFORT
    const info = this.models.get(cfg.model)
    if (!info) return requested

    // OpenRouter advertises disabled reasoning both as the `none` pseudo-effort
    // and as `mandatory: false`. The app exposes one unambiguous name for that
    // state. Accept the old/provider spelling too, so saved and shared settings
    // made before the UI was normalised keep doing what their author intended.
    if (requested === REASONING_OFF && info.canDisable === true) {
      return REASONING_OFF
    }

    const supported = info.efforts
    if (!supported || supported.includes(requested)) return requested

    this.events.onLog({
      kind: 'warn',
      player,
      text: `${cfg.model} doesn't accept "${cfg.effort}" reasoning — using its default`,
      detail: supported.length ? `Supported: ${supported.join(', ')}` : 'This model has no effort levels.',
    })
    return NO_EFFORT
  }

  private async playGame() {
    this.chess = new Chess()
    this.lastSay = ['', '']
    await this.events.onGameStart(this.gameIndex, this.white)
    this.events.onUpdate()

    let plies = 0
    let record: GameRecord | null = null

    while (!record) {
      if (this.abort.signal.aborted) return
      await this.waitIfPaused()
      if (this.abort.signal.aborted) return

      if (this.chess.isGameOver()) {
        record = this.recordFromPosition(plies)
        break
      }
      if (plies >= this.settings.maxPlies) {
        // Not an automatic draw: a side far enough ahead on material takes the
        // point. See adjudicate() for why, and for what that judgement misses.
        const verdict = adjudicate(this.chess)
        record = this.finish(verdict.result, adjudicationReason(this.settings.maxPlies, verdict), plies)
        break
      }

      const player = this.chess.turn() === 'w' ? this.white : this.black()
      const outcome = await this.requestMove(player)
      if (this.abort.signal.aborted || !outcome) return

      if ('forfeit' in outcome) {
        const result = player === this.white ? '0-1' : '1-0'
        record = this.finish(result, `${this.settings.players[player].label} forfeits (${outcome.forfeit})`, plies)
        break
      }

      const move = this.chess.move(outcome.san)
      plies++
      this.stats[player].moves++
      this.lastSay[player] = outcome.say

      await this.events.onMove({
        player,
        move,
        say: outcome.say,
        ms: outcome.ms,
        ply: plies,
        check: this.chess.isCheck(),
        mate: this.chess.isCheckmate(),
      })
      this.events.onLog({
        kind: 'move',
        player,
        text: `${Math.ceil(plies / 2)}${move.color === 'w' ? '.' : '...'} ${move.san}`,
        detail: outcome.say,
      })
      this.events.onUpdate()

      const delay = SPEEDS[this.settings.speed]?.delay ?? 0
      if (delay > 0) await this.sleep(delay)
    }

    if (!record) return
    this.games.push(record)
    this.applyResult(record)
    this.events.onLog({ kind: 'info', text: `Game ${record.index + 1}: ${record.result} — ${record.reason}` })
    await this.events.onGameEnd(record)
    this.events.onUpdate()
  }

  private recordFromPosition(plies: number): GameRecord {
    const c = this.chess
    if (c.isCheckmate()) {
      // Side to move is checkmated, so the other side won.
      const result = c.turn() === 'w' ? '0-1' : '1-0'
      return this.finish(result, 'checkmate', plies)
    }
    if (c.isStalemate()) return this.finish('1/2-1/2', 'stalemate', plies)
    if (c.isInsufficientMaterial()) return this.finish('1/2-1/2', 'insufficient material', plies)
    if (c.isThreefoldRepetition()) return this.finish('1/2-1/2', 'threefold repetition', plies)
    if (c.isDrawByFiftyMoves()) return this.finish('1/2-1/2', 'fifty-move rule', plies)
    return this.finish('1/2-1/2', 'draw', plies)
  }

  private finish(result: GameRecord['result'], reason: string, plies: number): GameRecord {
    return { index: this.gameIndex, white: this.white, result, reason, plies, pgn: this.chess.pgn() }
  }

  private applyResult(rec: GameRecord) {
    const w = rec.white
    const b = (1 - w) as PlayerIdx
    if (rec.result === '1-0') {
      this.stats[w].wins++, this.stats[w].score++, this.stats[b].losses++
    } else if (rec.result === '0-1') {
      this.stats[b].wins++, this.stats[b].score++, this.stats[w].losses++
    } else {
      this.stats[w].draws++, this.stats[b].draws++
      this.stats[w].score += 0.5
      this.stats[b].score += 0.5
    }
  }

  /** Asks a model for a move, re-prompting on illegal or truncated output.
   *  Null means the series was aborted mid-request. */
  private async requestMove(player: PlayerIdx): Promise<TurnOutcome | null> {
    const cfg = this.settings.players[player]
    const legal: LegalMove[] = this.chess.moves({ verbose: true }).map((m) => ({ san: m.san, lan: m.lan }))
    const history = this.chess.history()
    const messages: { role: 'system' | 'user' | 'assistant'; content: string }[] = [
      {
        role: 'system',
        content: systemPrompt(
          this.chess.turn() === 'w' ? 'white' : 'black',
          this.settings.commentary,
          this.settings.maxTokens,
        ),
      },
      {
        role: 'user',
        content: movePrompt(this.settings.promptTemplate, {
          fen: this.chess.fen(),
          board: this.chess.ascii(),
          pgn: cleanPgn(this.chess.pgn()),
          legal,
          inCheck: this.chess.isCheck(),
          lastMove: history[history.length - 1],
          moveNumber: this.chess.moveNumber(),
          color: this.chess.turn() === 'w' ? 'white' : 'black',
          player: cfg.label,
          opponent: this.settings.players[1 - player].label,
          gameNumber: this.gameIndex + 1,
          totalGames: this.settings.games,
          previousGames: this.settings.includePreviousGames ? this.games : [],
          includePreviousGames: this.settings.includePreviousGames,
          playerLabels: [this.settings.players[0].label, this.settings.players[1].label],
        }),
      },
    ]

    this.events.onThinking(player)
    // Timed across the whole turn, retries included, so the reported latency
    // matches how long the card actually said "thinking".
    const turnStarted = performance.now()

    // "random" is a built-in local opponent so the arena can be demoed with no API key.
    if (cfg.model.trim().toLowerCase() === 'random') {
      const pick = legal[Math.floor(Math.random() * legal.length)]
      this.stats[player].lastMs = 0
      this.events.onThinking(null)
      return { san: pick.san, say: 'Rolling the dice.', ms: 0 }
    }

    // A turn that ends in forfeit is blamed on the token cap only when every
    // failed attempt was a truncation — one genuinely illegal move makes it a
    // chess failure, not a budgeting one.
    let sawIllegal = false

    for (let attempt = 0; attempt <= this.settings.retries; attempt++) {
      const result = await this.chatWithRecovery(player, cfg, messages)
      // Aborted, or stalled and then abandoned.
      if (!result) return null

      this.stats[player].usage = addUsage(this.stats[player].usage, result.usage)
      this.stats[player].calls++
      this.stats[player].lastMs = performance.now() - turnStarted
      this.events.onUpdate()

      const parsed = parseMove(result.text, legal)
      if (parsed.san) {
        const turnMs = performance.now() - turnStarted
        this.stats[player].turns++
        this.stats[player].totalMs += turnMs
        this.stats[player].lastMs = turnMs
        this.events.onThinking(null)
        return { san: parsed.san, say: parsed.say, ms: turnMs }
      }

      // A reply with no content never made a move either. Providers disagree on
      // how they say so — some return finish_reason "length", others hand back
      // "stop" with an empty content field once reasoning has eaten the budget —
      // and calling the second one an illegal move blames chess for a budget
      // problem, which is the exact conflation `capped` exists to avoid.
      const truncated = result.finish === 'length' || !result.text.trim()
      if (truncated) this.stats[player].capped++
      else {
        this.stats[player].illegal++
        sawIllegal = true
      }

      this.events.onLog({
        kind: 'warn',
        player,
        text: truncated
          ? `Reply ended without a move — attempt ${attempt + 1} of ${this.settings.retries + 1}`
          : parsed.rejection === 'invalid_response'
            ? `Invalid response — attempt ${attempt + 1} of ${this.settings.retries + 1}`
            : `${parsed.rejection === 'invalid_notation' ? 'Invalid move notation' : 'Illegal move'} "${parsed.raw || '(empty)'}" — attempt ${attempt + 1} of ${this.settings.retries + 1}`,
        detail: truncated
          ? 'Raise "Max tokens / move" in Settings if this repeats.'
          : parsed.suggestion
            ? `Did you mean "${parsed.suggestion}"?`
            : undefined,
      })

      if (truncated) {
        // The tail of a truncated reply is an unfinished reasoning fragment, not a
        // turn the model stands behind — replaying it back would only anchor the
        // retry to the same overrun. Name the real cause instead.
        messages.push({ role: 'user', content: capRetryPrompt(this.settings.maxTokens, legal) })
      } else {
        messages.push({ role: 'assistant', content: result.text.slice(0, 500) })
        messages.push({
          role: 'user',
          content: retryPrompt(parsed.raw, legal, parsed.rejection ?? 'illegal_move', parsed.suggestion),
        })
      }
    }

    this.events.onThinking(null)
    return { forfeit: sawIllegal ? 'illegal moves' : 'token cap' }
  }

  /** One completion, riding out connection trouble.
   *
   *  Transient failures are retried with backoff on their own budget — a dropped
   *  connection isn't a chess mistake, so it must not spend `settings.retries`
   *  or count against the player's illegal/capped record. Whatever survives that
   *  parks the series instead of killing it: a blip an hour into a match should
   *  cost seconds, not the whole run. Null means aborted or abandoned. */
  private async chatWithRecovery(
    player: PlayerIdx,
    cfg: PlayerConfig,
    messages: { role: 'system' | 'user' | 'assistant'; content: string }[],
  ): Promise<ChatResult | null> {
    let tries = 0
    for (;;) {
      try {
        return await chat({
          baseUrl: this.settings.baseUrl,
          apiKey: this.settings.apiKey,
          model: cfg.model,
          effort: this.effort[player],
          temperature: cfg.temperature,
          maxTokens: this.settings.maxTokens,
          messages,
          pricing: this.models.get(cfg.model)?.pricing,
          signal: this.abort.signal,
        })
      } catch (err) {
        if (this.abort.signal.aborted) return null

        const cap = this.settings.networkRetries
        const transient = err instanceof ChatError && err.retryable
        const reason = `${cfg.model}: ${err instanceof Error ? err.message : String(err)}`

        if (transient && (cap === 0 || tries < cap)) {
          const wait = backoffMs(tries)
          tries++
          this.events.onLog({
            kind: 'warn',
            player,
            text: `Connection failed — retrying in ${Math.round(wait / 1000)}s`,
            detail: cap === 0 ? `${reason} · attempt ${tries + 1}` : `${reason} · attempt ${tries + 1} of ${cap + 1}`,
          })
          this.events.onThinking(null)
          await this.sleep(wait)
          if (this.abort.signal.aborted) return null
          this.events.onThinking(player)
          continue
        }

        if (!(await this.stall(reason, transient))) return null
        // Someone cleared it by hand, so the automatic budget starts over.
        tries = 0
      }
    }
  }

  /** Parks the series on the failed request until `retry()` or `stop()`. False
   *  means the series was abandoned. */
  private stall(reason: string, transient: boolean): Promise<boolean> {
    this.status = 'stalled'
    this.errorMessage = reason
    // Registered before anything is announced, so a listener that retries or
    // stops straight out of the event has something to resolve.
    const parked = new Promise<boolean>((resolve) => {
      if (this.abort.signal.aborted) return resolve(false)
      this.stallWaiters.push(resolve)
    })

    this.events.onThinking(null)
    this.events.onLog({
      kind: 'error',
      text: `Series stalled — ${reason}`,
      detail: transient
        ? 'The connection kept failing. Retry picks up from this same move; nothing is lost.'
        : 'This one needs a fix — check the API key and model id in Settings, then Retry.',
    })
    this.events.onUpdate()
    return parked
  }

  protected sleep(ms: number) {
    return new Promise<void>((resolve) => {
      // The listener has to come off when the timer wins, not only when the abort
      // does: a Cinematic ten-game series sleeps after every ply, and each of
      // those left a listener attached to one long-lived signal.
      const done = () => (clearTimeout(t), this.abort.signal.removeEventListener('abort', done), resolve())
      const t = setTimeout(done, ms)
      this.abort.signal.addEventListener('abort', done)
    })
  }

  private waitIfPaused() {
    if (this.status !== 'paused') return Promise.resolve()
    return new Promise<void>((resolve) => this.resumeWaiters.push(resolve))
  }
}
