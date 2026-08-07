/** Prompt variants under test.
 *
 *  `baseline` must stay byte-identical to what the arena actually sends, or the
 *  benchmark stops measuring the thing being shipped. It builds its messages from
 *  the same `systemPrompt`/`movePrompt` the series uses rather than a copy. */

import { Chess } from 'chess.js'
import { movePrompt, systemPrompt, type LegalMove } from '../prompt'
import { DEFAULT_PROMPT_TEMPLATE } from '../settings'
import type { Position } from './positions'

export type Message = { role: 'system' | 'user' | 'assistant'; content: string }

export type VariantContext = {
  position: Position
  legal: LegalMove[]
  color: 'white' | 'black'
  maxTokens: number
  player: string
  opponent: string
}

export type Variant = {
  name: string
  description: string
  build: (ctx: VariantContext) => Message[]
}

const baseArgs = (ctx: VariantContext) => {
  const chess = new Chess(ctx.position.fen)
  return {
    fen: ctx.position.fen,
    board: chess.ascii(),
    pgn: ctx.position.pgn,
    legal: ctx.legal,
    inCheck: chess.isCheck(),
    lastMove: ctx.position.lastMove,
    moveNumber: chess.moveNumber(),
    color: ctx.color,
    player: ctx.player,
    opponent: ctx.opponent,
    gameNumber: 1,
    totalGames: 1,
    previousGames: [],
    // Benchmark positions have no series history, so this is off for every
    // variant — leaving it on would just render "(none)" and measure nothing.
    includePreviousGames: false,
    playerLabels: [ctx.player, ctx.opponent] as [string, string],
  }
}

/** Exactly what the arena sends today, commentary included. */
export const baseline: Variant = {
  name: 'baseline',
  description: 'Current production prompt, commentary on',
  build: (ctx) => [
    { role: 'system', content: systemPrompt(ctx.color, true, ctx.maxTokens) },
    { role: 'user', content: movePrompt(DEFAULT_PROMPT_TEMPLATE, baseArgs(ctx)) },
  ],
}

/** Production prompt with the trash talk removed and nothing else changed, which
 *  isolates what co-generating commentary costs. */
export const noCommentary: Variant = {
  name: 'no-commentary',
  description: 'Production prompt, commentary off',
  build: (ctx) => [
    { role: 'system', content: systemPrompt(ctx.color, false, ctx.maxTokens) },
    { role: 'user', content: movePrompt(DEFAULT_PROMPT_TEMPLATE, baseArgs(ctx)) },
  ],
}

const PIECE_VALUE: Record<string, number> = { p: 1, n: 3, b: 3, r: 5, q: 9, k: 0 }

/** Attacked/defended tables for both sides.
 *
 *  Every fact here is already inside the FEN — the point is that deriving it is
 *  an expensive operation the model pays for out of the same budget it needs for
 *  chess, and small models mostly get it wrong. */
export function tacticalBrief(fen: string): string {
  const chess = new Chess(fen)
  const me = chess.turn()
  const mine: string[] = []
  const theirs: string[] = []

  for (const row of chess.board()) {
    for (const sq of row) {
      if (!sq || sq.type === 'k') continue
      const attackers = chess.attackers(sq.square, sq.color === 'w' ? 'b' : 'w')
      if (!attackers.length) continue
      const defenders = chess.attackers(sq.square, sq.color)
      const loose = defenders.length === 0 ? '  <-- UNDEFENDED' : ''
      const line =
        `  ${sq.type.toUpperCase()}${sq.square} (worth ${PIECE_VALUE[sq.type]}) ` +
        `attacked by ${attackers.join(',')} | defended by ${defenders.join(',') || 'nothing'}${loose}`
      ;(sq.color === me ? mine : theirs).push(line)
    }
  }

  return [
    'YOUR PIECES UNDER ATTACK:',
    mine.length ? mine.join('\n') : '  (none)',
    'THEIR PIECES UNDER ATTACK:',
    theirs.length ? theirs.join('\n') : '  (none)',
  ].join('\n')
}

/** Annotates each legal move with its origin square, so the model is not left
 *  reverse-engineering which piece "Nc5" refers to when two knights can go there. */
export function annotatedMoves(fen: string): string {
  const chess = new Chess(fen)
  return chess
    .moves({ verbose: true })
    .map((m) => {
      const captured = m.captured ? ` takes ${m.captured.toUpperCase()}(${PIECE_VALUE[m.captured]})` : ''
      return `${m.san} [${m.from}-${m.to}${captured}]`
    })
    .join('  ')
}

const IMPROVED_TEMPLATE = [
  `You are {{player}}, playing a game of chess as {{color}} against {{opponent}}.`,
  ``,
  `FEN: {{fen}}`,
  ``,
  `{{board}}`,
  ``,
  `Move number: {{moveNumber}}`,
  `Last move: {{lastMove}}`,
  `Check status: {{inCheck}}`,
  ``,
  `Moves so far: {{moves}}`,
].join('\n')

/** Scratch space plus derived tactical state — the two changes expected to carry
 *  most of the effect, tested together because they are cheap and complementary. */
export const scaffolded: Variant = {
  name: 'scaffolded',
  description: 'Reasoning field first, tactical brief, annotated legal moves',
  build: (ctx) => {
    const system = [
      `You are playing a game of chess as ${ctx.color}.`,
      `Act as a world-class chess engine and play to win.`,
      ``,
      `Respond with a single JSON object and nothing else, with the keys in this order:`,
      `{"threats": "<what your opponent threatens right now>", "candidates": "<2-3 moves you are considering and what is wrong with each>", "move": "<SAN>"}`,
      ``,
      `Think inside "threats" and "candidates" BEFORE committing to "move".`,
      `Check specifically: after your move, is the piece you moved defended? Does it leave anything hanging?`,
      ``,
      `"move" MUST be copied verbatim from the LEGAL MOVES list you are given.`,
      `No markdown, no code fences, no explanation outside the JSON.`,
      ``,
      `Your completion budget for each reply is ${ctx.maxTokens.toLocaleString('en-US')} tokens, and internal reasoning counts against it.`,
      `Reserve enough of that budget to finish the JSON object — a reply that stops mid-thought scores nothing.`,
    ].join('\n')

    const user = [
      movePrompt(IMPROVED_TEMPLATE, baseArgs(ctx)),
      ``,
      tacticalBrief(ctx.position.fen),
      ``,
      `LEGAL MOVES (${ctx.legal.length}), each with its origin square:`,
      annotatedMoves(ctx.position.fen),
      ``,
      `Choose your move.`,
    ].join('\n')

    return [
      { role: 'system', content: system },
      { role: 'user', content: user },
    ]
  },
}

export const VARIANTS: Variant[] = [baseline, noCommentary, scaffolded]

export const byName = (name: string): Variant => {
  const hit = VARIANTS.find((v) => v.name === name)
  if (!hit) throw new Error(`unknown variant "${name}" (have: ${VARIANTS.map((v) => v.name).join(', ')})`)
  return hit
}
