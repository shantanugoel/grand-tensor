/** Runs a series of model-vs-model games and keeps the score.
 *  Pure logic + events: it knows nothing about three.js or the DOM. */

import { Chess, type Move } from 'chess.js'
import { adjudicate, adjudicationReason } from './adjudication'
import { addUsage, chat, ChatError, emptyUsage, fetchModels, type ChatResult, type ModelInfo, type Usage } from './llm'
import { capRetryPrompt, cleanPgn, movePrompt, parseMove, retryPrompt, systemPrompt, type LegalMove } from './prompt'
import { NO_EFFORT, normalizeReasoningEffort, REASONING_OFF, SPEEDS, type PlayerConfig, type Settings } from './settings'
import { classifyLoss, MATE_CP, storeEval, type MoveEval, type StoredEval } from './verdict'
import { gradeInBrowser, type MoveGrade } from './browser-engine'

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
  /** The engine's verdict on each move of this game, indexed by ply.
   *
   *  Stored with the game so nothing is ever searched twice: the video export
   *  and every later replay read the numbers the live match already paid for,
   *  instead of standing up an engine of their own on a frame budget that has
   *  no room for one. A hole is a move whose search did not land — an engine
   *  that failed to load, or a match played before any of this existed — and
   *  reads as no verdict rather than as a wrong one.
   *
   *  Never submitted to the leaderboard. `gamesForSubmission` names the fields
   *  it sends one by one, and this is not among them: a client-side engine
   *  score is a claim the Worker cannot check. */
  evals?: (StoredEval | null)[]
}

export type LogEntry = {
  kind: 'move' | 'info' | 'warn' | 'error'
  /** Identifies the line so a verdict that arrives after it was printed can be
   *  patched into it. Unique within a run, absent on restored lines — a saved
   *  match already has whatever verdict it ended up with. */
  id?: number
  player?: PlayerIdx
  text: string
  detail?: string
  /** What the client-side evaluation made of the move. Only ever on a `move`
   *  line, and absent on matches saved before the verdicts existed — which is
   *  why the log has to render happily without it. Also absent at the moment
   *  the line is printed: the engine is still searching. See `onVerdict`. */
  eval?: MoveEval
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
  /** The verdict on a move that has already been played and logged.
   *
   *  Split out from `onMove` because a real search takes far longer than the
   *  board animation, and an arena that waited for one would stutter on every
   *  ply. The move goes up immediately and the label lands when it lands —
   *  usually within a second, and always long before the next turn, which is a
   *  model call measured in minutes. `square` is where the move finished, so
   *  the shout still knows where to appear. */
  onVerdict: (id: number, verdict: MoveEval, square: string) => void
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

/** Everything needed to put a series back on the board after a reload.
 *
 *  The pending API conversation is deliberately not part of it. `requestMove`
 *  rebuilds the entire prompt from the position on every turn, so a restored
 *  series has nothing to replay — it simply asks for the same move again. */
export type SeriesState = {
  status: Status
  stats: [PlayerStats, PlayerStats]
  games: GameRecord[]
  /** The game to play next. Always `games.length` for a series played in order,
   *  and the point a resumed run picks up from. */
  gameIndex: number
  /** Moves of the game under way. Empty between games and once the series ends,
   *  which is how a resume tells "carry on with this board" from "deal a new
   *  one" — the board itself still shows the last finished position either way. */
  pgn: string
  /** Verdicts for the game under way, the same shape a finished game stores.
   *  Without it a match resumed mid-game would come back with a hole where its
   *  first half's commentary was. Absent on matches saved before verdicts were
   *  stored at all. */
  evals?: (StoredEval | null)[]
  lastSay: [string, string]
  resolvedEffort: [string, string] | null
}

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

  /** Whether the board holds a game that is actually under way, as opposed to
   *  the last finished position left on screen between rounds. Only a live board
   *  is worth snapshotting, and only a live board is picked back up on resume. */
  private liveBoard = false
  /** Set by `restore`. A series that came off the shelf offers Resume instead of
   *  dealing a fresh match. */
  private restored = false
  /** Verdicts for the game under way, indexed by ply.
   *
   *  Handed to the `GameRecord` by reference when the game ends, so a search
   *  still in flight at that moment lands in the record rather than nowhere.
   *  A new game gets a new array, which is what keeps the two apart. */
  private gameEvals: (StoredEval | null)[] = []

  private abort = new AbortController()
  private resumeWaiters: (() => void)[] = []
  /** Resolved with true by `retry()`, false if the series is abandoned. */
  private stallWaiters: ((go: boolean) => void)[] = []
  /** What the endpoint says about each model: pricing and supported efforts. */
  private models = new Map<string, ModelInfo>()
  private effort: [string, string] = [NO_EFFORT, NO_EFFORT]
  /** Avoid flooding the Battle log if a provider repeatedly ignores `off`. */
  private reportedReasoningWhileOff: [boolean, boolean] = [false, false]

  /** Hands each logged move a name the late verdict can find it by. */
  private nextVerdictId = 0

  /** How a move gets its real grade. Injectable so a test can drive the late
   *  verdict path without a browser, and so the engine stays one swappable
   *  thing rather than an import baked into the move loop. */
  constructor(
    private settings: Settings,
    private events: SeriesEvents,
    private grade: (fen: string, san: string) => Promise<MoveGrade | null> = gradeInBrowser,
  ) {}

  get totalGames() {
    return this.settings.games
  }

  /** Score is 1 / 0.5 / 0 per game; the higher total takes the crown. */
  get leader(): PlayerIdx | null {
    const [a, b] = this.stats
    if (a.score === b.score) return null
    return a.score > b.score ? 0 : 1
  }

  /** A restored series with games left in it. */
  get resumable() {
    return this.restored && this.status === 'idle' && this.gameIndex < this.settings.games
  }

  /** A point to come back to. Cheap enough to call after every move. */
  state(): SeriesState {
    return {
      status: this.status,
      stats: structuredClone(this.stats),
      games: structuredClone(this.games),
      // Completed games are pushed in order, so the game being played is always
      // the one at `games.length` — which is also where a resume restarts.
      gameIndex: this.games.length,
      pgn: this.liveBoard ? this.chess.pgn() : '',
      evals: this.liveBoard ? [...this.gameEvals] : [],
      lastSay: [...this.lastSay],
      resolvedEffort: this.resolvedEffort ? [...this.resolvedEffort] : null,
    }
  }

  /** Puts a stored series back. Must be called before `run`.
   *
   *  Whatever the state was saved under, it comes back parked: `run` is what
   *  starts play again, so nothing here can be left claiming to be running. */
  restore(state: SeriesState) {
    this.stats = structuredClone(state.stats)
    this.games = structuredClone(state.games)
    this.gameIndex = Math.min(Math.max(state.gameIndex, 0), this.settings.games)
    this.white = (this.gameIndex % 2) as PlayerIdx
    this.lastSay = [...state.lastSay]
    this.gameEvals = state.evals ? [...state.evals] : []
    this.resolvedEffort = state.resolvedEffort ? [...state.resolvedEffort] : null
    this.restored = true
    this.status = state.status === 'done' || this.gameIndex >= this.settings.games ? 'done' : 'idle'

    // The board shows the game in progress, or — between rounds and at the end
    // of a series — the position the last game finished on. Only the first of
    // those is picked back up; the other is just what should be on screen.
    this.liveBoard = state.pgn !== ''
    this.chess = new Chess()
    const board = state.pgn || this.games[this.games.length - 1]?.pgn || ''
    if (board) {
      try {
        this.chess.loadPgn(board)
      } catch {
        // A record that no longer parses costs its position and nothing else:
        // the score and the games already in the book are still good.
        this.chess = new Chess()
        this.liveBoard = false
      }
    }
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
    const resuming = this.resumable && (this.gameIndex > 0 || this.liveBoard)
    this.status = 'running'
    this.events.onLog({
      kind: 'info',
      text: resuming
        ? `Series resumed at game ${this.gameIndex + 1} of ${this.settings.games}`
        : `Series started — best of ${this.settings.games}`,
    })
    this.models = await fetchModels(this.settings.baseUrl, this.settings.apiKey)
    this.effort = this.settings.players.map((p, i) => this.resolveEffort(p, i as PlayerIdx)) as [string, string]
    this.resolvedEffort = this.effort
    this.events.onUpdate()
    try {
      // Not initialised here: a restored series starts from the game it was left
      // on, and a fresh one is already sitting at zero.
      for (; this.gameIndex < this.settings.games; this.gameIndex++) {
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
    // A restored series carries on with the board the reload interrupted, and
    // keeps the commentary that was on the cards when it did.
    const resumed = this.liveBoard
    if (!resumed) {
      this.chess = new Chess()
      this.lastSay = ['', '']
      this.liveBoard = true
    }
    // A resumed game keeps the verdicts it already earned — `restore` put them
    // back; a fresh one starts with none. Either way the array belongs to this
    // game alone, and the record it ends up in holds this same reference.
    if (!resumed) this.gameEvals = []
    await this.events.onGameStart(this.gameIndex, this.white)
    this.events.onUpdate()

    let plies = this.chess.history().length
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

      // The position the move was played from — the node both searches are
      // rooted at. Taken before the move lands, because after it there is no
      // way back to it.
      const from = this.chess.fen()
      const move = this.chess.move(outcome.san)
      plies++
      this.stats[player].moves++
      this.lastSay[player] = outcome.say

      // Logged before the search starts, and before the animation is awaited.
      // A grade can beat the board home — it is a hundred milliseconds against
      // an animation plus a frame or two — and a verdict that arrives before the
      // line it belongs to has nothing to attach itself to.
      const verdictId = this.nextVerdictId++
      const ply = plies
      this.events.onLog({
        kind: 'move',
        id: verdictId,
        player,
        text: `${Math.ceil(plies / 2)}${move.color === 'w' ? '.' : '...'} ${move.san}`,
        detail: outcome.say,
      })
      void this.gradeMove(verdictId, ply, from, move)

      await this.events.onMove({
        player,
        move,
        say: outcome.say,
        ms: outcome.ms,
        ply: plies,
        check: this.chess.isCheck(),
        mate: this.chess.isCheckmate(),
      })
      this.events.onUpdate()

      const delay = SPEEDS[this.settings.speed]?.delay ?? 0
      if (delay > 0) await this.sleep(delay)
    }

    if (!record) return
    this.games.push(record)
    // The position stays on screen until the next game is dealt, but it is a
    // finished one now — a resume must not pick it back up.
    this.liveBoard = false
    this.applyResult(record)
    this.events.onLog({ kind: 'info', text: `Game ${record.index + 1}: ${record.result} — ${record.reason}` })
    await this.events.onGameEnd(record)
    this.events.onUpdate()
  }

  /** Puts a real engine's verdict on a move that has already been played.
   *
   *  Never awaited by the move loop. A search is orders of magnitude slower than
   *  the shallow evaluation it replaces, and blocking on it would make the arena
   *  wait on the commentary — so the move is shown, and this catches up.
   *
   *  Nothing here can influence the game: it reads a position it was handed and
   *  emits a label. The result, the adjudication and the standings are decided
   *  by `adjudicate()` on material alone, which is what makes them something the
   *  Worker can recompute from the PGN. An engine verdict is a claim only this
   *  browser can make, so it never gets a vote. */
  private async gradeMove(id: number, ply: number, fen: string, move: Move): Promise<void> {
    // The board state is read now rather than when the search returns, by which
    // time `this.chess` has moved on several plies. `isDraw` is asked once, here,
    // rather than per frame — it replays the game to answer about repetition.
    const ended = { mate: this.chess.isCheckmate(), draw: this.chess.isDraw() }
    const grade = await this.grade(fen, move.san)
    // No verdict at all rather than a worse one from somewhere else. A move the
    // engine could not reach keeps its line in the log, unlabelled.
    if (!grade || this.abort.signal.aborted) return
    const verdict = verdictFrom(grade, move, ended)
    // Kept for the video and every later replay, so this search is the only one
    // this move ever costs.
    this.gameEvals[ply - 1] = storeEval(verdict)
    this.events.onVerdict(id, verdict, move.to)
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
    // The array is handed over by reference on purpose: a search still running
    // when the game ends writes into the record rather than into nothing.
    return { index: this.gameIndex, white: this.white, result, reason, plies, pgn: this.chess.pgn(), evals: this.gameEvals }
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
      if (
        this.effort[player] === REASONING_OFF &&
        result.usage.reasoning > 0 &&
        !this.reportedReasoningWhileOff[player]
      ) {
        this.reportedReasoningWhileOff[player] = true
        this.events.onLog({
          kind: 'warn',
          player,
          text: `${cfg.model} reported reasoning tokens even though reasoning is off`,
          detail: `The provider reported ${result.usage.reasoning.toLocaleString('en-US')} reasoning tokens for this call.`,
        })
      }
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

/** An engine grade in the arcade's own vocabulary.
 *
 *  Centipawn loss is already exactly what `MoveEval.loss` means — what the mover
 *  gave up — so the bands are the ones the log has always used and the numbers
 *  underneath them are finally real. The one thing that does not survive the
 *  translation is `brilliant`: a loss against the engine's best move cannot be
 *  negative, so a move can no longer beat the evaluation that judges it. */
function verdictFrom(grade: MoveGrade, move: Move, ended: { mate: boolean; draw: boolean }): MoveEval {
  // `playedCp` is the score of the move from the point of view of whoever played
  // it, so white's books need it flipped for black.
  const cp = move.color === 'w' ? grade.playedCp : -grade.playedCp
  if (ended.mate) return { cp: move.color === 'w' ? MATE_CP : -MATE_CP, mate: true, draw: false, loss: 0, tag: 'mate' }
  return {
    cp: ended.draw ? 0 : cp,
    mate: false,
    draw: ended.draw,
    loss: grade.cpl,
    tag: classifyLoss(grade.cpl),
  }
}
