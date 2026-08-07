/** The shot list for the match video: a finished series' PGNs turned into
 *  something the recorder can walk from start to finish.
 *
 *  Pure — no DOM, no three.js, no MediaRecorder. The pacing arithmetic is the
 *  part most likely to go wrong (a long series has to stay inside X's 2:20 cap),
 *  and keeping it here means it can be tested without a browser. */

import { Chess } from 'chess.js'
import type { GameRecord, PlayerIdx } from './series'
import { fmtScore } from './share'
import { SPEEDS } from './settings'

/** Semantic type scale for a title card. share-video maps these to faces and
 *  pixel sizes; the storyboard only says how loud a line is. */
export type CardSize = 'hero' | 'title' | 'label' | 'note'
export type CardTone = 'p0' | 'p1' | 'gold' | 'text' | 'dim'

export type CardLine = { text: string; size: CardSize; tone: CardTone }
export type CardView = { lines: CardLine[] }

export type StoryGame = {
  index: number
  white: PlayerIdx
  /** SAN moves, replayed straight back through Arena.animateMove. */
  moves: string[]
  /** Shown over the reset board before the first move. */
  intro: CardView
  /** Shown over the final position once the last move has landed. */
  outro: CardView
  /** Series score to caption the game with, and what it becomes afterwards.
   *  Showing the finished score for the whole video would give the ending away. */
  scoreBefore: [string, string]
  scoreAfter: [string, string]
}

export type Storyboard = {
  names: [string, string]
  totalGames: number
  totalPlies: number
  intro: CardView
  games: StoryGame[]
  outro: CardView
}

/** Blitz. The export replays at this unless the series is too long to fit. */
export const BLITZ_ANIM = SPEEDS[1].anim

/** What Arena.animateMove costs per ply at speed 1 — the hop, then the landing
 *  squash. Both scale with Arena.speed. */
const MOVE_MS = 340 + 140
/** Per-ply slop: a frame lost at each end of the tween, plus the position
 *  rebuild that follows it. */
const PLY_OVERHEAD_MS = 24

/** How long each title card holds, fades included. */
export const CARD_MS = {
  intro: 2600,
  gameIntro: 1600,
  gameOutro: 2000,
  outro: 4000,
}

/** X refuses a post whose video runs past 2:20. */
export const POST_LIMIT_MS = 140_000

/** What the pacing aims at. Under the hard limit, because the encoder's own
 *  duration drifts from the wall clock and a rejected upload is the one failure
 *  the viewer can do nothing about. */
export const TARGET_MS = 125_000

/** Below this the pieces teleport and the capture effects have nothing to play
 *  over. A series long enough to need it overruns the target instead of becoming
 *  unwatchable — roughly 1,200 plies is where that starts, since each ply also
 *  costs a couple of frames that no animation scale can compress away. The
 *  caller warns when the estimate won't fit a post. */
const MIN_ANIM = 0.05

export const cardMsFor = (gameCount: number) =>
  CARD_MS.intro + CARD_MS.outro + gameCount * (CARD_MS.gameIntro + CARD_MS.gameOutro)

/** Animation scale to replay at: Blitz, tightened only as far as fitting the
 *  budget demands. */
export function paceFor(totalPlies: number, cardMs: number, budgetMs = TARGET_MS): number {
  if (totalPlies <= 0) return BLITZ_ANIM
  const perPly = (budgetMs - cardMs) / totalPlies - PLY_OVERHEAD_MS
  if (perPly <= 0) return MIN_ANIM
  return Math.max(MIN_ANIM, Math.min(BLITZ_ANIM, perPly / MOVE_MS))
}

export const estimateMs = (totalPlies: number, cardMs: number, anim: number) =>
  cardMs + totalPlies * (MOVE_MS * anim + PLY_OVERHEAD_MS)

export const plyMs = (anim: number) => MOVE_MS * anim + PLY_OVERHEAD_MS

/** SAN moves out of a stored PGN. A game whose PGN won't parse costs its own
 *  moves and nothing else — the storyboard keeps its cards, so the video still
 *  reports the result. */
export function parseMoves(pgn: string): string[] {
  try {
    const chess = new Chess()
    chess.loadPgn(pgn)
    return chess.history()
  } catch {
    return []
  }
}

export const winnerOf = (rec: GameRecord): PlayerIdx | null =>
  rec.result === '1/2-1/2' ? null : ((rec.result === '1-0' ? rec.white : 1 - rec.white) as PlayerIdx)

/** Series score after each game, as a running total. One entry per game plus the
 *  0–0 the series opened on. */
export function runningScores(games: GameRecord[]): [number, number][] {
  const out: [number, number][] = [[0, 0]]
  let a = 0
  let b = 0
  for (const rec of games) {
    const winner = winnerOf(rec)
    if (winner === null) {
      a += 0.5
      b += 0.5
    } else if (winner === 0) a += 1
    else b += 1
    out.push([a, b])
  }
  return out
}

const tone = (player: PlayerIdx): CardTone => (player === 0 ? 'p0' : 'p1')

export function buildStoryboard(input: {
  games: GameRecord[]
  names: [string, string]
  totalGames: number
  /** Footer of the closing card. Passed in so this stays free of `location`. */
  url: string
}): Storyboard {
  const { games, names, totalGames, url } = input
  const scores = runningScores(games)
  const fmtPair = (pair: [number, number]): [string, string] => [fmtScore(pair[0]), fmtScore(pair[1])]

  const story: StoryGame[] = games.map((rec, i) => {
    const winner = winnerOf(rec)
    const black = (1 - rec.white) as PlayerIdx
    const moves = parseMoves(rec.pgn)

    return {
      index: rec.index,
      white: rec.white,
      moves,
      scoreBefore: fmtPair(scores[i]),
      scoreAfter: fmtPair(scores[i + 1]),
      intro: {
        lines: [
          { text: `GAME ${rec.index + 1} OF ${totalGames}`, size: 'label', tone: 'dim' },
          { text: names[rec.white].toUpperCase(), size: 'title', tone: tone(rec.white) },
          { text: 'plays white', size: 'note', tone: 'dim' },
          { text: names[black].toUpperCase(), size: 'title', tone: tone(black) },
          { text: 'plays black', size: 'note', tone: 'dim' },
        ],
      },
      outro: {
        lines: [
          {
            text: winner === null ? 'DRAW' : `${names[winner].toUpperCase()} WINS`,
            size: 'hero',
            tone: winner === null ? 'text' : tone(winner),
          },
          { text: `${rec.reason} · ${Math.ceil(rec.plies / 2)} moves`, size: 'note', tone: 'dim' },
          {
            text: `${fmtScore(scores[i + 1][0])} – ${fmtScore(scores[i + 1][1])}`,
            size: 'title',
            tone: 'gold',
          },
        ],
      },
    }
  })

  const final = scores[scores.length - 1]
  const leader: PlayerIdx | null = final[0] === final[1] ? null : final[0] > final[1] ? 0 : 1

  return {
    names,
    totalGames,
    totalPlies: story.reduce((n, g) => n + g.moves.length, 0),
    games: story,
    intro: {
      lines: [
        { text: 'GRAND TENSOR', size: 'hero', tone: 'p0' },
        { text: names[0].toUpperCase(), size: 'title', tone: 'p0' },
        { text: 'versus', size: 'note', tone: 'dim' },
        { text: names[1].toUpperCase(), size: 'title', tone: 'p1' },
        { text: `BEST OF ${totalGames}`, size: 'label', tone: 'dim' },
      ],
    },
    outro: {
      lines: [
        { text: `${fmtScore(final[0])} – ${fmtScore(final[1])}`, size: 'hero', tone: 'gold' },
        {
          text: leader === null ? `DEAD HEAT AFTER ${games.length}` : `${names[leader].toUpperCase()} TAKES THE CROWN`,
          size: 'title',
          tone: leader === null ? 'text' : tone(leader),
        },
        { text: url, size: 'note', tone: 'dim' },
      ],
    },
  }
}
