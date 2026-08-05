/** Runs a series of model-vs-model games and keeps the score.
 *  Pure logic + events: it knows nothing about three.js or the DOM. */

import { Chess, type Move } from 'chess.js'
import { addUsage, chat, emptyUsage, type Usage } from './llm'
import { movePrompt, parseMove, retryPrompt, systemPrompt, type LegalMove } from './prompt'
import { SPEEDS, type Settings } from './settings'

export type PlayerIdx = 0 | 1

export type PlayerStats = {
  wins: number
  draws: number
  losses: number
  score: number
  moves: number
  illegal: number
  usage: Usage
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
  usage: emptyUsage(),
  totalMs: 0,
  lastMs: 0,
})

export type Status = 'idle' | 'running' | 'paused' | 'done' | 'error'

export class Series {
  chess = new Chess()
  status: Status = 'idle'
  stats: [PlayerStats, PlayerStats] = [newStats(), newStats()]
  games: GameRecord[] = []
  gameIndex = 0
  white: PlayerIdx = 0
  lastSay: [string, string] = ['', '']
  errorMessage = ''

  private abort = new AbortController()
  private resumeWaiters: (() => void)[] = []

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

  stop() {
    this.abort.abort()
    this.resumeWaiters.splice(0).forEach((fn) => fn())
  }

  async run() {
    this.status = 'running'
    this.events.onLog({ kind: 'info', text: `Series started — best of ${this.settings.games}` })
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
        record = this.finish('1/2-1/2', `move limit (${this.settings.maxPlies} plies)`, plies)
        break
      }

      const player = this.chess.turn() === 'w' ? this.white : this.black()
      const outcome = await this.requestMove(player)
      if (this.abort.signal.aborted) return

      if (!outcome) {
        const result = player === this.white ? '0-1' : '1-0'
        record = this.finish(result, `${this.settings.players[player].label} forfeits (illegal moves)`, plies)
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

  /** Asks a model for a move, re-prompting on illegal output. Null = forfeit. */
  private async requestMove(player: PlayerIdx): Promise<{ san: string; say: string; ms: number } | null> {
    const cfg = this.settings.players[player]
    const legal: LegalMove[] = this.chess.moves({ verbose: true }).map((m) => ({ san: m.san, lan: m.lan }))
    const history = this.chess.history()
    const messages: { role: 'system' | 'user' | 'assistant'; content: string }[] = [
      { role: 'system', content: systemPrompt(this.chess.turn() === 'w' ? 'white' : 'black', this.settings.commentary) },
      {
        role: 'user',
        content: movePrompt({
          fen: this.chess.fen(),
          pgn: this.chess.pgn().replace(/\[[^\]]*\]\s*/g, '').trim(),
          legal,
          inCheck: this.chess.isCheck(),
          lastMove: history[history.length - 1],
          moveNumber: this.chess.moveNumber(),
        }),
      },
    ]

    this.events.onThinking(player)

    // "random" is a built-in local opponent so the arena can be demoed with no API key.
    if (cfg.model.trim().toLowerCase() === 'random') {
      const pick = legal[Math.floor(Math.random() * legal.length)]
      this.stats[player].lastMs = 0
      this.events.onThinking(null)
      return { san: pick.san, say: 'Rolling the dice.', ms: 0 }
    }

    for (let attempt = 0; attempt <= this.settings.retries; attempt++) {
      let result
      try {
        result = await chat({
          baseUrl: this.settings.baseUrl,
          apiKey: this.settings.apiKey,
          model: cfg.model,
          effort: cfg.effort,
          temperature: cfg.temperature,
          maxTokens: this.settings.maxTokens,
          messages,
          signal: this.abort.signal,
        })
      } catch (err) {
        if (this.abort.signal.aborted) return null
        // Transport/auth problems are the operator's to fix — stop the series.
        throw new Error(`${cfg.model}: ${err instanceof Error ? err.message : String(err)}`)
      }

      this.stats[player].usage = addUsage(this.stats[player].usage, result.usage)
      this.stats[player].totalMs += result.ms
      this.stats[player].lastMs = result.ms
      this.events.onUpdate()

      const parsed = parseMove(result.text, legal)
      if (parsed.san) {
        this.events.onThinking(null)
        return { san: parsed.san, say: parsed.say, ms: result.ms }
      }

      this.stats[player].illegal++
      const truncated = result.finish === 'length'
      this.events.onLog({
        kind: 'warn',
        player,
        text: truncated
          ? `Reply hit the token cap before a move appeared — attempt ${attempt + 1} of ${this.settings.retries + 1}`
          : `Illegal move "${parsed.raw || '(empty)'}" — attempt ${attempt + 1} of ${this.settings.retries + 1}`,
        detail: truncated ? 'Raise "Max tokens / move" in Settings if this repeats.' : undefined,
      })
      messages.push({ role: 'assistant', content: result.text.slice(0, 500) })
      messages.push({ role: 'user', content: retryPrompt(parsed.raw, legal) })
    }

    this.events.onThinking(null)
    return null
  }

  private sleep(ms: number) {
    return new Promise<void>((resolve) => {
      const t = setTimeout(resolve, ms)
      this.abort.signal.addEventListener('abort', () => (clearTimeout(t), resolve()), { once: true })
    })
  }

  private waitIfPaused() {
    if (this.status !== 'paused') return Promise.resolve()
    return new Promise<void>((resolve) => this.resumeWaiters.push(resolve))
  }
}
