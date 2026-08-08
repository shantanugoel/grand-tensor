import { describe, expect, test } from 'bun:test'
import { Chess } from 'chess.js'
import {
  classifyLoss,
  Commentator,
  evaluate,
  fmtEval,
  fmtSwing,
  judgeMove,
  MATE_CP,
  TAG_LABEL,
  TAG_SHOUT,
  type EvalRead,
  type EvalTag,
} from './tiny-eval'

const at = (fen: string) => evaluate(new Chess(fen))

/** Plays a line from the opening position and returns the position after it. */
function line(...sans: string[]): Chess {
  const chess = new Chess()
  for (const san of sans) chess.move(san)
  return chess
}

describe('evaluate', () => {
  test('reads the opening position as dead level', () => {
    // Both armies are mirror images, so anything other than zero here is a bug
    // in the mirroring rather than an opinion about chess.
    expect(evaluate(new Chess()).cp).toBe(0)
  })

  test('stays symmetric under colour reversal', () => {
    const white = at('rnbqkbnr/pppppppp/8/8/4P3/8/PPPP1PPP/RNBQKBNR b KQkq - 0 1')
    const black = at('rnbqkbnr/pppp1ppp/8/4p3/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 2')
    expect(white.cp).toBe(-black.cp)
  })

  test('counts material in the units a chess player expects', () => {
    // A rook up is worth about five pawns, whatever the positional terms add.
    const rookUp = at('rnbqkbn1/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR b KQq - 0 1').cp
    expect(rookUp).toBeGreaterThan(450)
    expect(rookUp).toBeLessThan(600)

    const queenDown = at('rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNB1KBNR b KQkq - 0 1').cp
    expect(queenDown).toBeLessThan(-850)
  })

  test('prefers a centre pawn to a rook pawn, and a castled king to a stranded one', () => {
    expect(at('rnbqkbnr/pppppppp/8/8/4P3/8/PPPP1PPP/RNBQKBNR b KQkq - 0 1').cp).toBeGreaterThan(
      at('rnbqkbnr/pppppppp/8/8/8/P7/1PPPPPPP/RNBQKBNR b KQkq - 0 1').cp,
    )
    // Same material, same pieces; white has castled and black has not.
    expect(at('r1bqk2r/pppp1ppp/2n2n2/2b1p3/2B1P3/3P1N2/PPP2PPP/RNBQ1RK1 b kq - 0 1').cp).toBeGreaterThan(0)
  })

  test('sees a passed pawn on the seventh', () => {
    // A single pawn, but one move from a queen: worth far more than a pawn.
    expect(at('4k3/7P/8/8/8/8/8/4K3 b - - 0 1').cp).toBeGreaterThan(300)
  })

  test('scores a mate on the board at MATE_CP, from white’s point of view', () => {
    // Fool's mate: white is the one mated, so the score is black's.
    const fools = line('f3', 'e5', 'g4', 'Qh4#')
    expect(evaluate(fools)).toEqual({ cp: -MATE_CP, mate: true, draw: false })
  })

  test('scores a dead position as a draw rather than as material', () => {
    // Stalemate: black is a queen up and it is worth exactly nothing.
    expect(at('7k/8/6QK/8/8/8/8/8 b - - 0 1')).toEqual({ cp: 0, mate: false, draw: true })
    expect(at('4k3/8/8/8/8/8/8/4K3 w - - 0 1').draw).toBe(true)
  })

  test('sees loose material a piece-square table would miss', () => {
    // Black's queen sits on h4 attacked by nothing but defended by nothing
    // either; white to move can take it with the g3 pawn for free.
    const free = at('rnb1kbnr/pppp1ppp/8/4p3/7q/5PP1/PPPPP2P/RNBQKBNR w KQkq - 0 3').cp
    // Without the hanging term this position reads as roughly level material.
    expect(free).toBeGreaterThan(400)
  })
})

describe('judgeMove', () => {
  /** Judges one move played from `chess`, which is left holding the result. */
  const play = (chess: Chess, san: string) => {
    const before = evaluate(chess)
    const move = chess.move(san)
    return judgeMove(before, evaluate(chess), move.color)
  }

  test('calls a normal developing move nothing in particular', () => {
    const verdict = play(new Chess(), 'Nf3')
    expect(Math.abs(verdict.loss)).toBeLessThan(70)
    expect(['best', 'good']).toContain(verdict.tag)
  })

  test('calls leaving a queen en prise a catastrophe, from either colour', () => {
    // White's queen is attacked by the g6 pawn and white plays elsewhere. The
    // verdict lands on the move that ignored the threat, not on the capture two
    // plies later — which is the whole reason the evaluation looks at what is
    // hanging at all.
    const white = line('e4', 'e5', 'Qh5', 'Nc6', 'Bc4', 'g6')
    const thrown = play(white, 'Nf3')
    expect(thrown.tag).toBe('catastrophe')
    expect(thrown.loss).toBeGreaterThan(500)
    // A verdict is measured against the mover, so black walking a queen onto a
    // square the g3 pawn covers has to come out the same way — and leave the
    // score pointing at white.
    const black = line('e4', 'e5', 'g3')
    const mirrored = play(black, 'Qh4')
    expect(mirrored.tag).toBe('catastrophe')
    expect(mirrored.loss).toBeGreaterThan(500)
    expect(mirrored.cp).toBeGreaterThan(0)
  })

  test('scales the verdict to the piece that was hung', () => {
    // The same move, played by a knight and then by a rook, onto the same square
    // in front of the same black pawn: what changes is only what it cost.
    expect(play(new Chess('4k3/8/4p3/8/8/2N5/8/4K3 w - - 0 1'), 'Nd5').tag).toBe('mistake')
    expect(play(new Chess('4k3/8/4p3/8/8/8/8/3RK3 w - - 0 1'), 'Rd5').tag).toBe('blunder')
  })

  test('charges leaving free material on the table too', () => {
    // Black's knight is en prise to the d-pawn and white wanders off with the
    // king. Declining a free piece costs what taking it would have won.
    const declined = play(new Chess('4k3/8/8/4n3/3P4/8/8/4K3 w - - 0 1'), 'Kd1')
    expect(declined.tag).toBe('mistake')
    expect(declined.loss).toBeGreaterThan(150)
  })

  test('tags the move that ends the game rather than pricing it', () => {
    const scholars = line('e4', 'e5', 'Bc4', 'Nc6', 'Qh5', 'Nf6')
    const mate = play(scholars, 'Qxf7#')
    expect(mate).toMatchObject({ tag: 'mate', mate: true, loss: 0, cp: MATE_CP })
  })

  test('bands a swing the way a chess player would name it', () => {
    expect(classifyLoss(-400)).toBe('brilliant')
    expect(classifyLoss(0)).toBe('best')
    expect(classifyLoss(40)).toBe('good')
    expect(classifyLoss(80)).toBe('inaccuracy')
    expect(classifyLoss(200)).toBe('mistake')
    expect(classifyLoss(400)).toBe('blunder')
    expect(classifyLoss(700)).toBe('catastrophe')
  })
})

describe('Commentator', () => {
  /** Plays a line, judging every move, and returns the verdicts by SAN. */
  function commentate(...sans: string[]): { san: string; tag: string; loss: number }[] {
    const chess = new Chess()
    const commentator = new Commentator()
    commentator.reset(chess)
    return sans.map((san) => {
      const move = chess.move(san)
      const verdict = commentator.judge(chess, move)
      return { san, tag: verdict.tag, loss: verdict.loss }
    })
  }

  test('judges the move that left the queen hanging', () => {
    // ...g6 attacks the queen and Nf3 ignores it. The verdict belongs to Nf3:
    // the queen was not lost until its owner declined to move it.
    const byMove = Object.fromEntries(
      commentate('e4', 'e5', 'Qh5', 'Nc6', 'Bc4', 'g6', 'Nf3').map((v) => [v.san, v.tag]),
    )
    expect(TAG_LABEL[byMove['g6'] as EvalTag]).toBe('')
    expect(byMove['Nf3']).toBe('catastrophe')
  })

  test('says nothing about a recapture, which settles a bill already read out', () => {
    const verdicts = commentate('e4', 'd5', 'exd5', 'Qxd5')
    expect(verdicts[verdicts.length - 1]).toMatchObject({ san: 'Qxd5', tag: 'quiet' })
  })

  test('withholds an opinion on a sacrifice, rather than getting it wrong', () => {
    // Morphy's finish at the opera: a queen sacrifice that mates next move. A
    // one-ply evaluation sees a queen thrown away, which is exactly the sort of
    // verdict it is not qualified to give — so it gives none.
    const chess = new Chess()
    const opera =
      'e4 e5 Nf3 d6 d4 Bg4 dxe5 Bxf3 Qxf3 dxe5 Bc4 Nf6 Qb3 Qe7 Nc3 c6 Bg5 b5 Nxb5 cxb5 Bxb5+ Nbd7 O-O-O Rd8 Rxd7 Rxd7 Rd1 Qe6 Bxd7+ Nxd7'
    for (const san of opera.split(' ')) chess.move(san)

    const commentator = new Commentator()
    commentator.reset(chess)
    const sac = commentator.judge(chess, chess.move('Qb8+'))
    expect(sac.tag).toBe('quiet')
    // The score is still recorded — only the opinion is withheld.
    expect(sac.loss).toBeGreaterThan(300)
    // The forced reply is not black's fault either, and the mate that follows
    // is still worth announcing.
    expect(commentator.judge(chess, chess.move('Nxb8')).tag).toBe('quiet')
    expect(commentator.judge(chess, chess.move('Rd8#')).tag).toBe('mate')
  })

  test('stays quiet through a normal opening', () => {
    const verdicts = commentate('e4', 'e5', 'Nf3', 'Nc6', 'Bb5', 'a6', 'Ba4', 'Nf6', 'O-O', 'Be7')
    expect(verdicts.every((v) => TAG_LABEL[v.tag as keyof typeof TAG_LABEL] === '')).toBe(true)
  })
})

describe('the vocabulary', () => {
  test('says nothing about an ordinary move, in the log or over the board', () => {
    for (const tag of ['best', 'good'] as const) {
      expect(TAG_LABEL[tag]).toBe('')
      expect(TAG_SHOUT[tag]).toEqual([])
    }
  })

  test('shouts over the board only for the swings worth the interruption', () => {
    // Mate has its own fanfare already, and an inaccuracy is not worth stopping
    // the fight for — both stay out of the arena and keep their log line.
    expect(TAG_SHOUT.mate).toEqual([])
    expect(TAG_SHOUT.inaccuracy).toEqual([])
    expect(TAG_LABEL.mate).toBe('MATE')
    expect(TAG_LABEL.inaccuracy).toBe('INACCURACY')
    for (const tag of ['mistake', 'blunder', 'catastrophe', 'brilliant'] as const) {
      expect(TAG_SHOUT[tag].length).toBeGreaterThan(0)
      expect(TAG_LABEL[tag]).not.toBe('')
    }
  })
})

describe('reading it back', () => {
  const read = (cp: number, extra: Partial<EvalRead> = {}): EvalRead => ({ cp, mate: false, draw: false, ...extra })

  test('prints the score the way a broadcast does', () => {
    expect(fmtEval(read(0))).toBe('0.00')
    expect(fmtEval(read(124))).toBe('+1.24')
    expect(fmtEval(read(-31))).toBe('−0.31')
    expect(fmtEval(read(MATE_CP, { mate: true }))).toBe('MATE')
    expect(fmtEval(read(0, { draw: true }))).toBe('DRAW')
  })

  test('prints a swing from the mover’s side of it: what the move cost them', () => {
    expect(fmtSwing(340)).toBe('−3.4')
    expect(fmtSwing(-412)).toBe('+4.1')
    expect(fmtSwing(0)).toBe('+0.0')
  })
})
