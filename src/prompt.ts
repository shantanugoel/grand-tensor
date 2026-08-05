/** Prompt construction and (deliberately forgiving) move parsing. */

export type LegalMove = { san: string; lan: string }

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

export function movePrompt(args: {
  fen: string
  pgn: string
  legal: LegalMove[]
  inCheck: boolean
  lastMove?: string
  moveNumber: number
}): string {
  const lines = [
    `FEN: ${args.fen}`,
    `Move number: ${args.moveNumber}`,
    args.lastMove ? `Opponent just played: ${args.lastMove}` : `You are opening the game.`,
    args.inCheck ? `YOU ARE IN CHECK — you must resolve it.` : ``,
    ``,
    `Moves so far: ${args.pgn || '(none)'}`,
    ``,
    `LEGAL MOVES (${args.legal.length}): ${args.legal.map((m) => m.san).join(' ')}`,
    ``,
    `Choose your move.`,
  ]
  return lines.filter(Boolean).join('\n')
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
