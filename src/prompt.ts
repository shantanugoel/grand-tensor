/** Prompt construction and (deliberately forgiving) move parsing. */

export type LegalMove = { san: string; lan: string }

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
  return [
    `You are playing a game of chess as ${color}.`,
    `Act as a world-class chess engine and play to win.`,
    ``,
    `Respond with a single JSON object and nothing else:`,
    commentary
      ? `{"move": "<SAN>", "say": "<one short sentence of trash talk or reasoning, max 12 words>"}`
      : `{"move": "<SAN>"}`,
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
  'previousGames',
] as const

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
  const values: Record<(typeof PROMPT_VARIABLES)[number], string> = {
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

  return template.replace(/\{\{([A-Za-z][A-Za-z0-9]*)\}\}/g, (match, name: string) =>
    name in values ? values[name as keyof typeof values] : match,
  )
}

export function retryPrompt(bad: string, legal: LegalMove[]): string {
  return [
    `"${bad}" is not a legal chess move here.`,
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
export function parseMove(text: string, legal: LegalMove[]): { san: string | null; say: string; raw: string } {
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
    if (hit) return { san: hit, say, raw: candidate }
  }

  return { san: null, say, raw: candidate || cleaned.slice(0, 60) }
}
