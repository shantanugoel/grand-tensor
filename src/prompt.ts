/** Prompt construction and (deliberately forgiving) move parsing. */

import { Chess } from 'chess.js'

export type LegalMove = { san: string; lan: string }
export type MoveRejection = 'invalid_response' | 'invalid_notation' | 'illegal_move'

export type PromptGame = {
  index: number
  white: 0 | 1
  result: '1-0' | '0-1' | '1/2-1/2'
  reason: string
  pgn: string
}

export type MovePromptArgs = {
  fen: string
  /** The position drawn out square by square. FEN is exact but compressed, and
   *  reconstructing a board from it is a parsing exercise the model pays for out
   *  of the same budget it needs for chess. */
  board: string
  pgn: string
  legal: LegalMove[]
  inCheck: boolean
  lastMove?: string
  moveNumber: number
  color: 'white' | 'black'
  player: string
  opponent: string
  gameNumber: number
  totalGames: number
  previousGames: PromptGame[]
  includePreviousGames: boolean
  playerLabels: [string, string]
}

/** Thousands separators, pinned to en-US so every player is told the budget in
 *  exactly the same words regardless of the operator's locale. */
const fmtCap = (n: number) => n.toLocaleString('en-US')

export function systemPrompt(color: 'white' | 'black', commentary: boolean, maxTokens: number): string {
  // Key order is load-bearing. JSON is generated left to right, so "move" first
  // meant committing to an answer before a single token of thought — and for a
  // model with no separate reasoning channel, that was the whole of its thinking.
  // "threats" and "candidates" are scratch space bought for the price of a field.
  // "say" stays last: trash talk must not delay the move it comments on.
  const shape = ['"threats": "<what your opponent threatens right now>"', '"candidates": "<2-3 moves you are considering, and what is wrong with each>"', '"move": "<SAN>"']
  if (commentary) shape.push('"say": "<one short sentence of trash talk, max 12 words>"')

  return [
    `You are playing a game of chess as ${color}.`,
    `Act as a world-class chess engine and play to win.`,
    ``,
    `Respond with a single JSON object and nothing else, with the keys in this order:`,
    `{${shape.join(', ')}}`,
    ``,
    `Think inside "threats" and "candidates" BEFORE committing to "move".`,
    `After your move, is the piece you moved defended? Does it leave anything hanging?`,
    `A check or a capture is not automatically good — weigh what you win against what the moved piece is worth on the square it lands on.`,
    ``,
    `"move" MUST be copied verbatim from the LEGAL MOVES list you are given.`,
    `No markdown, no code fences, no explanation outside the JSON.`,
    ``,
    // Reasoning tokens are billed as completion tokens, so a max-effort model can
    // spend the entire budget thinking and never emit the JSON. Both players are
    // told the same number so the warning costs neither of them an advantage.
    `Your completion budget for each reply is ${fmtCap(maxTokens)} tokens, and internal reasoning counts against it.`,
    `Reserve enough of that budget to finish the JSON object — a reply that stops mid-thought scores nothing.`,
  ].join('\n')
}

export const PROMPT_VARIABLES = [
  'player',
  'opponent',
  'color',
  'gameNumber',
  'totalGames',
  'fen',
  'board',
  'moveNumber',
  'lastMove',
  'inCheck',
  'moves',
  'legalMoveCount',
  'legalMoves',
  'annotatedMoves',
  'threats',
  'previousGames',
] as const

const PIECE_VALUE: Record<string, number> = { p: 1, n: 3, b: 3, r: 5, q: 9, k: 0 }

/** Attacked and defended pieces for both sides, from the mover's point of view.
 *
 *  Every fact here is already implied by the FEN. The point is that deriving it
 *  is bookkeeping the model otherwise pays for out of the same budget it needs
 *  for chess — and measurably gets wrong. Kings are skipped: they cannot be
 *  captured, so listing them is noise. */
export function tacticalBrief(fen: string): string {
  const chess = new Chess(fen)
  const me = chess.turn()
  const mine: string[] = []
  const theirs: string[] = []

  for (const row of chess.board()) {
    for (const square of row) {
      if (!square || square.type === 'k') continue
      const attackers = chess.attackers(square.square, square.color === 'w' ? 'b' : 'w')
      if (!attackers.length) continue
      const defenders = chess.attackers(square.square, square.color)
      const line =
        `  ${square.type.toUpperCase()}${square.square} (worth ${PIECE_VALUE[square.type]}) ` +
        `attacked by ${attackers.join(',')} | defended by ${defenders.join(',') || 'nothing'}` +
        (defenders.length ? '' : '  <-- UNDEFENDED')
      ;(square.color === me ? mine : theirs).push(line)
    }
  }

  return [
    'YOUR PIECES UNDER ATTACK:',
    mine.length ? mine.join('\n') : '  (none)',
    'THEIR PIECES UNDER ATTACK:',
    theirs.length ? theirs.join('\n') : '  (none)',
  ].join('\n')
}

/** Each legal move with its origin square and what awaits it on arrival.
 *
 *  The origin square stops the model working out which knight "Nc5" means. The
 *  landing-square status addresses the failure that actually costs games:
 *  recapturing with the wrong piece is not a missed capture, it is an unchecked
 *  destination. Only contested squares are annotated, so the extra tokens fall
 *  on the moves where they change the answer.
 *
 *  Deliberately descriptive rather than advisory — a contested square is very
 *  often where the best move goes, and calling every one of them unsafe would
 *  trade blunders for timidity. */
export function annotatedMoves(fen: string): string {
  const chess = new Chess(fen)
  return chess
    .moves({ verbose: true })
    .map((move) => {
      const captured = move.captured
        ? ` takes ${move.captured.toUpperCase()}(${PIECE_VALUE[move.captured]})`
        : ''

      // Read from the position *after* the move: "can they take it back?" has no
      // answer in the position before it.
      const after = new Chess(fen)
      after.move(move.san)
      const attackers = after.attackers(move.to, move.color === 'w' ? 'b' : 'w')
      let landing = ''
      if (attackers.length) {
        const defenders = after.attackers(move.to, move.color)
        const piece = `${move.piece.toUpperCase()}(${PIECE_VALUE[move.piece]})`
        landing = defenders.length
          ? ` — ${move.to} contested: your ${piece} attacked by ${attackers.join(',')}, defended by ${defenders.join(',')}`
          : ` — HANGS: your ${piece} on ${move.to} attacked by ${attackers.join(',')}, defended by nothing`
      }

      return `${move.san} [${move.from}-${move.to}${captured}]${landing}`
    })
    .join('\n')
}

/** Movetext only: no header tags, and no trailing result token.
 *
 *  `chess.pgn()` always terminates the movetext with a result — `*` while the
 *  game is unfinished. Left in, a fresh game rendered as "Moves so far: *", and
 *  a completed one repeated a result the surrounding line already states. */
export const cleanPgn = (pgn: string) =>
  pgn
    .replace(/\[[^\]]*\]\s*/g, '')
    .replace(/\s*(?:\*|1-0|0-1|1\/2-1\/2)\s*$/, '')
    .trim()

/** Completed games rendered with player identities and colors. */
export function previousGamesPrompt(games: PromptGame[], labels: [string, string]): string {
  if (!games.length) return '(none — this is the first game)'
  return games
    .map((game) => {
      const white = labels[game.white]
      const black = labels[1 - game.white]
      return [
        `Game ${game.index + 1}: ${white} (White) vs ${black} (Black) — ${game.result}, ${game.reason}`,
        `Moves: ${cleanPgn(game.pgn) || '(none)'}`,
      ].join('\n')
    })
    .join('\n\n')
}

/** Replaces known {{variables}}. Unknown placeholders are left visible so a
 *  misspelling is apparent in the actual prompt rather than silently erased. */
export function movePrompt(template: string, args: MovePromptArgs): string {
  const values: Record<Exclude<(typeof PROMPT_VARIABLES)[number], 'annotatedMoves' | 'threats'>, string> = {
    player: args.player,
    opponent: args.opponent,
    color: args.color,
    gameNumber: String(args.gameNumber),
    totalGames: String(args.totalGames),
    fen: args.fen,
    board: args.board,
    moveNumber: String(args.moveNumber),
    lastMove: args.lastMove ? `Opponent played ${args.lastMove}.` : 'You are opening the game.',
    inCheck: args.inCheck ? 'YOU ARE IN CHECK — you must resolve it.' : 'You are not in check.',
    moves: cleanPgn(args.pgn) || '(none)',
    legalMoveCount: String(args.legal.length),
    legalMoves: args.legal.map((m) => m.san).join(' '),
    previousGames: args.includePreviousGames ? previousGamesPrompt(args.previousGames, args.playerLabels) : '(not included)',
  }

  /** Derived from the FEN the caller already supplies, so these needed no new
   *  plumbing through the series — but they are the only variables that parse a
   *  board rather than format a string, so they are resolved on demand. A custom
   *  template that never mentions them should not pay to build them, and a FEN
   *  this module cannot read must not take a whole turn down: the prompt loses
   *  one section, and the model still gets a position and a legal move list. */
  const derived: Record<string, () => string> = {
    annotatedMoves: () => annotatedMoves(args.fen),
    threats: () => tacticalBrief(args.fen),
  }

  return template.replace(/\{\{([A-Za-z][A-Za-z0-9]*)\}\}/g, (match, name: string) => {
    if (name in values) return values[name as keyof typeof values]
    const build = derived[name]
    if (!build) return match
    try {
      return build()
    } catch {
      return '(unavailable for this position)'
    }
  })
}

export function retryPrompt(
  bad: string,
  legal: LegalMove[],
  rejection: MoveRejection = 'illegal_move',
  suggestion: string | null = null,
): string {
  const problem =
    rejection === 'invalid_response'
      ? `Your reply did not contain a usable "move" value.`
      : rejection === 'invalid_notation'
        ? `"${bad}" is invalid move notation here.`
        : `"${bad}" is not a legal chess move here.`
  return [
    problem,
    ...(suggestion ? [`Did you mean "${suggestion}"?`] : []),
    `Pick one move copied exactly from this list: ${legal.map((m) => m.san).join(' ')}`,
    `Reply with JSON only.`,
  ].join('\n')
}

/** A reply that ran out of budget never made a move at all, so calling it
 *  illegal is both wrong and useless — it invites the same overrun again. Also
 *  covers a reply that came back empty, which is the same failure wearing a
 *  different finish_reason. */
export function capRetryPrompt(maxTokens: number, legal: LegalMove[]): string {
  return [
    `Your previous reply produced no move — it returned nothing, or reached the ${fmtCap(maxTokens)}-token completion limit first.`,
    `This attempt has the same limit and the same reasoning effort, so think more briefly and emit the JSON early.`,
    `Pick one move copied exactly from this list: ${legal.map((m) => m.san).join(' ')}`,
    `Reply with JSON only.`,
  ].join('\n')
}

const normalize = (s: string) => s.replace(/[+#!?\s]/g, '').replace(/0/g, 'O')

/** Syntax only. Whether the move is legal in the current position is decided by
 *  matching the generated legal list. SAN permits one file/rank disambiguator;
 *  LAN names both complete squares and optionally a promotion piece. */
function isMoveNotation(value: string): boolean {
  const v = normalize(value)
  if (!v) return false
  if (/^[a-h][1-8][a-h][1-8][qrbn]?$/i.test(v)) return true
  return /^(?:O-O(?:-O)?|[a-h](?:x[a-h])?[1-8](?:=[QRBN])?|[KQRBN][a-h1-8]?x?[a-h][1-8])$/i.test(v)
}

/** Find a unique canonical SAN differing only by commonly omitted capture or
 *  promotion punctuation. This is a diagnostic suggestion, never acceptance. */
function notationSuggestion(value: string, legal: LegalMove[]): string | null {
  const loose = normalize(value).replace(/[x=]/gi, '').toLowerCase()
  if (!loose) return null
  const matches = legal.filter(
    (m) => normalize(m.san).replace(/[x=]/gi, '').toLowerCase() === loose,
  )
  return matches.length === 1 ? matches[0].san : null
}

/** The first balanced `{…}` in the text, string-aware so a brace inside a quoted
 *  value doesn't throw off the depth count. Greedy `\{[\s\S]*\}` matched from the
 *  first brace to the *last* one anywhere in the reply, so a well-formed object
 *  followed by a stray `}` in prose stopped parsing at all. */
function firstJsonObject(text: string): string | null {
  for (let start = text.indexOf('{'); start !== -1; start = text.indexOf('{', start + 1)) {
    let depth = 0
    let inString = false
    let escaped = false
    for (let i = start; i < text.length; i++) {
      const ch = text[i]
      if (inString) {
        if (escaped) escaped = false
        else if (ch === '\\') escaped = true
        else if (ch === '"') inString = false
        continue
      }
      if (ch === '"') inString = true
      else if (ch === '{') depth++
      else if (ch === '}' && --depth === 0) return text.slice(start, i + 1)
    }
  }
  return null
}

/** Pulls the move out of the JSON object the model was asked for.
 *
 *  Only out of the JSON object. An earlier version fell back to scanning the
 *  whole reply for any token that happened to resolve to a legal move, which
 *  turned "the model failed to answer" into "the model played something" — and
 *  usually played a line it was arguing against. A move has to be one the model
 *  actually nominated, so the answer must arrive in the shape it was asked for
 *  and the retry budget handles the rest. */
export function parseMove(
  text: string,
  legal: LegalMove[],
): {
  san: string | null
  say: string
  raw: string
  rejection: MoveRejection | null
  suggestion: string | null
} {
  const cleaned = text.replace(/```[a-z]*|```/gi, '').trim()
  let say = ''
  let candidate = ''

  const block = firstJsonObject(cleaned)
  if (block) {
    try {
      const obj = JSON.parse(block)
      if (typeof obj.move === 'string') candidate = obj.move
      if (typeof obj.say === 'string') say = obj.say
    } catch {
      // Repair, not prose mining: this reads the declared keys out of an object
      // that is malformed elsewhere — an unescaped quote in `say` is the usual
      // culprit, and it has nothing to do with the move the model picked.
      const m = block.match(/"move"\s*:\s*"([^"]+)"/)
      const s = block.match(/"say"\s*:\s*"([^"]*)"/)
      if (m) candidate = m[1]
      if (s) say = s[1]
    }
  }

  const resolve = (value: string): string | null => {
    const v = normalize(value)
    if (!v) return null
    const bySan = legal.find((m) => normalize(m.san) === v) ?? legal.find((m) => normalize(m.san).toLowerCase() === v.toLowerCase())
    if (bySan) return bySan.san
    const byLan = legal.find((m) => m.lan.toLowerCase() === v.toLowerCase())
    return byLan ? byLan.san : null
  }

  if (candidate) {
    const hit = resolve(candidate)
    if (hit) {
      return {
        san: hit,
        say,
        raw: candidate,
        rejection: null,
        suggestion: null,
      }
    }
  }

  const suggestion = notationSuggestion(candidate, legal)
  const rejection: MoveRejection = !candidate
    ? 'invalid_response'
    : suggestion || !isMoveNotation(candidate)
      ? 'invalid_notation'
      : 'illegal_move'

  return {
    san: null,
    say,
    raw: candidate || cleaned.slice(0, 60),
    rejection,
    suggestion,
  }
}
