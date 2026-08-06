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

export function systemPrompt(color: 'white' | 'black', commentary: boolean): string {
  return [
    `You are a world-class chess engine playing ${color}. Play to win.`,
    ``,
    `Respond with a single JSON object and nothing else:`,
    commentary
      ? `{"move": "<SAN>", "say": "<one short sentence of trash talk or reasoning, max 12 words>"}`
      : `{"move": "<SAN>"}`,
    ``,
    `"move" MUST be copied verbatim from the LEGAL MOVES list you are given.`,
    `No markdown, no code fences, no explanation outside the JSON.`,
  ].join('\n')
}

export const PROMPT_VARIABLES = [
  'player',
  'opponent',
  'color',
  'gameNumber',
  'totalGames',
  'fen',
  'moveNumber',
  'lastMove',
  'inCheck',
  'moves',
  'legalMoveCount',
  'legalMoves',
  'previousGames',
] as const

const cleanPgn = (pgn: string) => pgn.replace(/\[[^\]]*\]\s*/g, '').trim()

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
    moveNumber: String(args.moveNumber),
    lastMove: args.lastMove ? `Opponent played ${args.lastMove}.` : 'You are opening the game.',
    inCheck: args.inCheck ? 'YOU ARE IN CHECK — you must resolve it.' : 'You are not in check.',
    moves: args.pgn || '(none)',
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
    `"${bad}" is not a legal move here.`,
    `Pick one move copied exactly from this list: ${legal.map((m) => m.san).join(' ')}`,
    `Reply with JSON only.`,
  ].join('\n')
}

const normalize = (s: string) => s.replace(/[+#!?\s]/g, '').replace(/0/g, 'O')

/** Pulls a legal SAN out of whatever the model actually returned. */
export function parseMove(text: string, legal: LegalMove[]): { san: string | null; say: string; raw: string } {
  const cleaned = text.replace(/```[a-z]*|```/gi, '').trim()
  let say = ''
  let candidate = ''

  const objMatch = cleaned.match(/\{[\s\S]*\}/)
  if (objMatch) {
    try {
      const obj = JSON.parse(objMatch[0])
      if (typeof obj.move === 'string') candidate = obj.move
      if (typeof obj.say === 'string') say = obj.say
    } catch {
      // Fall through to loose key scraping — models sometimes emit broken JSON.
      const m = cleaned.match(/"move"\s*:\s*"([^"]+)"/)
      const s = cleaned.match(/"say"\s*:\s*"([^"]*)"/)
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

  // Last resort: scan the prose for any legal move token, preferring the last one
  // mentioned (models tend to end with their answer).
  const tokens = cleaned.match(/[A-Za-z][A-Za-z0-9+#=-]{1,6}/g) ?? []
  for (let i = tokens.length - 1; i >= 0; i--) {
    const hit = resolve(tokens[i])
    if (hit) return { san: hit, say, raw: candidate || tokens[i] }
  }

  return { san: null, say, raw: candidate || cleaned.slice(0, 60) }
}
