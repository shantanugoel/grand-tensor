import { expect, test, describe } from 'bun:test'
import { Chess } from 'chess.js'
import { negate, toCp } from './engine'
import { engineAvailable, stockfishEngine } from './stdio'
import { classify, CPL_CAP, Grader, toUci } from './cpl'
import { comparePaired, summarize } from './stats'
import { generate, fromPgn } from './positions'
import { annotatedMoves, baseline, scaffolded, tacticalBrief } from './variants'
import { systemPrompt } from '../prompt'
import { ChatError } from '../llm'
import { retrying } from './run'

const START = 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1'

describe('score conversion', () => {
  test('mate scores order correctly against each other and centipawns', () => {
    expect(toCp({ cp: 0, mate: 1 })).toBeGreaterThan(toCp({ cp: 0, mate: 5 }))
    expect(toCp({ cp: 0, mate: 5 })).toBeGreaterThan(toCp({ cp: 2000, mate: null }))
    expect(toCp({ cp: 0, mate: -1 })).toBeLessThan(toCp({ cp: -2000, mate: null }))
  })

  test('negating flips both the centipawn value and the mate distance', () => {
    expect(negate({ cp: 120, mate: null })).toEqual({ cp: -120, mate: null })
    expect(negate({ cp: 0, mate: 3 })).toEqual({ cp: -0, mate: -3 })
  })
})

describe('classification', () => {
  test('bands match the thresholds they document', () => {
    expect(classify(0)).toBe('best')
    expect(classify(9)).toBe('best')
    expect(classify(10)).toBe('good')
    expect(classify(60)).toBe('inaccuracy')
    expect(classify(150)).toBe('mistake')
    expect(classify(900)).toBe('blunder')
  })
})

describe('toUci', () => {
  test('resolves legal SAN and rejects anything else', () => {
    expect(toUci(START, 'e4')).toBe('e2e4')
    expect(toUci(START, 'Nf3')).toBe('g1f3')
    expect(toUci(START, 'e5')).toBeNull()
    expect(toUci(START, 'Qh5')).toBeNull()
  })
})

describe('stats', () => {
  test('summary reports the tail, not just the mean', () => {
    const s = summarize([0, 0, 0, 0, 0, 0, 0, 0, 0, 1000])
    expect(s.n).toBe(10)
    expect(s.meanCpl).toBe(100)
    expect(s.medianCpl).toBe(0)
    expect(s.blunderRate).toBeCloseTo(0.1)
    expect(s.bestRate).toBeCloseTo(0.9)
  })

  test('a real paired improvement is detected', () => {
    const base = new Map<string, number>()
    const better = new Map<string, number>()
    // Position difficulty varies wildly but the variant is consistently 50 better.
    for (let i = 0; i < 60; i++) {
      base.set(`p${i}`, i * 13 + 100)
      better.set(`p${i}`, i * 13 + 50)
    }
    const c = comparePaired(base, better)
    expect(c.n).toBe(60)
    expect(c.meanDiff).toBeCloseTo(50)
    expect(c.significant).toBe(true)
  })

  test('pure noise is not called a difference', () => {
    const base = new Map<string, number>()
    const same = new Map<string, number>()
    for (let i = 0; i < 60; i++) {
      base.set(`p${i}`, (i * 37) % 200)
      same.set(`p${i}`, (i * 37) % 200)
    }
    const c = comparePaired(base, same)
    expect(c.meanDiff).toBe(0)
    expect(c.significant).toBe(false)
  })

  test('only positions present in both arms are paired', () => {
    const base = new Map([['a', 10], ['b', 20]])
    const partial = new Map([['a', 5]])
    expect(comparePaired(base, partial).n).toBe(1)
  })
})

describe('transient failure handling', () => {
  const noWait = async () => {}

  test('rides out a retryable failure and returns the eventual success', async () => {
    let calls = 0
    const result = await retrying(
      async () => {
        if (++calls < 3) throw new ChatError('HTTP 429: Provider returned error', true)
        return 'ok'
      },
      5,
      noWait,
    )
    expect(result).toBe('ok')
    expect(calls).toBe(3)
  })

  test('a non-retryable failure is raised at once, not retried', async () => {
    // A rejected key or an unknown model fails identically forever; retrying it
    // only turns a fast error into a slow one.
    let calls = 0
    await expect(
      retrying(
        async () => {
          calls++
          throw new ChatError('HTTP 401: no credit', false)
        },
        5,
        noWait,
      ),
    ).rejects.toThrow('401')
    expect(calls).toBe(1)
  })

  test('gives up after the attempt budget rather than looping forever', async () => {
    let calls = 0
    await expect(
      retrying(
        async () => {
          calls++
          throw new ChatError('HTTP 429', true)
        },
        3,
        noWait,
      ),
    ).rejects.toThrow('429')
    expect(calls).toBe(4) // the first try plus three retries
  })

  test('backoff grows and is jittered, so workers do not retry in lockstep', async () => {
    const waits: number[] = []
    await expect(
      retrying(
        async () => {
          throw new ChatError('HTTP 429', true)
        },
        3,
        async (ms) => void waits.push(ms),
      ),
    ).rejects.toThrow()
    expect(waits).toHaveLength(3)
    // Jitter is +/-50% of 1s, 2s, 4s, so the bands cannot overlap but no two
    // runs produce the same delay.
    expect(waits[0]).toBeGreaterThanOrEqual(500)
    expect(waits[0]).toBeLessThan(1500)
    expect(waits[2]).toBeGreaterThanOrEqual(2000)
    expect(waits[2]).toBeLessThan(6000)
  })
})

describe('tactical brief', () => {
  test('names the attackers and defenders of a contested pawn', () => {
    // 1. e4 e5 2. Nf3 Nc6 — e5 is attacked by f3 and defended by c6.
    const chess = new Chess()
    for (const m of ['e4', 'e5', 'Nf3', 'Nc6']) chess.move(m)
    const brief = tacticalBrief(chess.fen())
    expect(brief).toContain('Pe5')
    expect(brief).toContain('attacked by f3')
    expect(brief).toContain('defended by c6')
  })

  test('flags a genuinely undefended piece', () => {
    // Black bishop on b4 attacked by the a3 pawn with nothing covering it.
    const fen = 'rnbqk1nr/pppp1ppp/8/4p3/1b6/P7/1PPPPPPP/RNBQKBNR b KQkq - 0 3'
    const brief = tacticalBrief(fen)
    expect(brief).toContain('Bb4')
    expect(brief).toContain('UNDEFENDED')
  })

  test('is written from the side to move point of view', () => {
    const chess = new Chess()
    for (const m of ['e4', 'e5', 'Nf3', 'Nc6']) chess.move(m)
    const brief = tacticalBrief(chess.fen())
    // White to move, so the black e5 pawn is one of THEIR pieces.
    const mine = brief.slice(0, brief.indexOf('THEIR PIECES'))
    expect(mine).not.toContain('Pe5')
    expect(brief.slice(brief.indexOf('THEIR PIECES'))).toContain('Pe5')
  })

  test('kings are never listed as capturable', () => {
    const chess = new Chess()
    for (const m of ['e4', 'e5', 'Nf3', 'Nc6', 'Bb5']) chess.move(m)
    expect(tacticalBrief(chess.fen())).not.toContain('Ke8')
  })
})

describe('annotated moves', () => {
  test('every move carries its origin square', () => {
    const text = annotatedMoves(START)
    expect(text).toContain('e4 [e2-e4]')
    expect(text).toContain('Nf3 [g1-f3]')
  })

  test('captures name the piece taken and its value', () => {
    const fen = 'rnbqkbnr/ppp1pppp/8/3p4/4P3/8/PPPP1PPP/RNBQKBNR w KQkq - 0 2'
    expect(annotatedMoves(fen)).toContain('exd5 [e4-d5 takes P(1)]')
  })

  test('a safe move carries no landing-square warning', () => {
    const line = annotatedMoves(START).split('\n').find((l) => l.startsWith('Nf3 '))!
    expect(line).toBe('Nf3 [g1-f3]')
  })

  test('the measured Qxb6 blunder is flagged, and the right move is not', () => {
    // The exact position where Luna played Qxb6 (queen takes a pawn onto a square
    // two pieces still cover) instead of Ba6, losing 899cp.
    const fen = '2r2rk1/p6p/1pn1bp2/2qp2p1/5p2/1Q3N2/PR1BBPPP/3N1RK1 w - - 6 22'
    const lines = annotatedMoves(fen).split('\n')
    const blunder = lines.find((l) => l.startsWith('Qxb6 '))!
    expect(blunder).toContain('takes P(1)')
    expect(blunder).toContain('your Q(9) attacked by a7,c5')
    expect(lines.find((l) => l.startsWith('Ba6 '))).toBe('Ba6 [e2-a6]')
  })

  test('an undefended landing square is called out as hanging', () => {
    // Black bishop can drop to b4 where only the a3 pawn covers it.
    const fen = 'rnbqk1nr/pppp1ppp/8/4p3/1b6/P7/1PPPPPPP/RNBQKBNR b KQkq - 0 3'
    const line = annotatedMoves(fen).split('\n').find((l) => l.startsWith('Bxa3 '))
    expect(line).toContain('HANGS')
    expect(line).toContain('defended by nothing')
  })
})

describe('variants', () => {
  const ctx = {
    position: { id: 't', fen: START, pgn: '', ply: 0, phase: 'opening' as const },
    legal: new Chess(START).moves({ verbose: true }).map((m) => ({ san: m.san, lan: m.lan })),
    color: 'white' as const,
    maxTokens: 16000,
    player: 'A',
    opponent: 'B',
  }

  test('baseline reproduces the production system prompt exactly', () => {
    const [system] = baseline.build(ctx)
    expect(system.content).toBe(systemPrompt('white', true, 16000))
  })

  test('baseline user message carries the board and the legal move list', () => {
    const [, user] = baseline.build(ctx)
    expect(user.content).toContain('FEN: ' + START)
    expect(user.content).toContain('LEGAL MOVES (20)')
  })

  test('scaffolded puts reasoning keys before the move', () => {
    const [system] = scaffolded.build(ctx)
    expect(system.content.indexOf('"threats"')).toBeLessThan(system.content.indexOf('"move"'))
    expect(system.content.indexOf('"candidates"')).toBeLessThan(system.content.indexOf('"move"'))
  })

  test('scaffolded includes the tactical brief and annotated moves', () => {
    const [, user] = scaffolded.build(ctx)
    expect(user.content).toContain('YOUR PIECES UNDER ATTACK:')
    expect(user.content).toContain('[e2-e4]')
  })
})

describe('position sets', () => {
  test('sampled plies mix parity so both colours get graded', async () => {
    const pgn = new Chess()
    // A long enough game to reach the later sample points.
    const moves = ['e4','e5','Nf3','Nc6','Bb5','a6','Ba4','Nf6','O-O','Be7','Re1','b5','Bb3','d6','c3','O-O','h3','Nb8','d4','Nbd7','c4','c6','cxb5','axb5','Nc3','Bb7','Bg5','b4','Nb1','h6','Bh4','c5','dxe5','Nxe4','Bxe7','Qxe7','exd6','Qf6','Nbd2','Nxd6','Nc4','Nxc4','Bxc4','Nb6','Ne5','Rae8','Bxf7+','Rxf7','Nxf7','Rxe1+','Qxe1','Kxf7','Qe3','Qg5','Qxg5','hxg5','b3','Ke6','a3','Kd6','axb4','cxb4','Ra5','Nd5','f3','Bc8','Kf2','Bf5','Ra7','g6','Ra6+','Kc5','Ke1','Nf4','g3','Nxh3','Kd2','Kb5','Rd6','Kc5','Ra6','Nf2','g4','Bd3','Re6']
    for (const m of moves) pgn.move(m)
    const positions = await fromPgn(pgn.pgn())
    expect(positions.length).toBeGreaterThan(4)
    const sides = new Set(positions.map((p) => new Chess(p.fen).turn()))
    expect(sides.has('w')).toBe(true)
    expect(sides.has('b')).toBe(true)
  })

  test('malformed PGN entries are skipped, not fatal', async () => {
    expect(await fromPgn('this is not a pgn at all')).toEqual([])
  })
})

describe('finding an engine', () => {
  // Regression: this used to report anything that spawned as an engine, so on a
  // machine with no Stockfish the `stockfish` shim `bun install` drops into
  // node_modules/.bin answered for one — and the whole engine suite failed on CI
  // instead of skipping. Nothing short of a UCI handshake settles the question.
  test('is not fooled by something that merely runs', async () => {
    expect(await engineAvailable('/bin/echo')).toBe(false)
    expect(await engineAvailable('definitely-not-an-engine')).toBe(false)
  }, 30_000)
})

// The engine is an external binary, so these degrade to a skip rather than a
// failure on a machine that has not installed it.
const hasEngine = await engineAvailable()

describe.if(hasEngine)('engine grading', () => {
  test('grades a sound move at zero and a bad one well above it', async () => {
    const engine = stockfishEngine({ depth: 10 })
    await engine.ready()
    const grader = new Grader(engine, 10)
    try {
      const good = await grader.grade(START, 'e4')
      const bad = await grader.grade(START, 'Nh3')
      expect(good.cpl).toBe(0)
      expect(good.best).toBe('e4')
      expect(bad.cpl).toBeGreaterThan(good.cpl)
      expect(bad.cpl).toBeLessThanOrEqual(CPL_CAP)
    } finally {
      await engine.close()
    }
  }, 120_000)

  test('an illegal move is refused rather than scored', async () => {
    const engine = stockfishEngine({ depth: 8 })
    await engine.ready()
    try {
      await expect(new Grader(engine, 8).grade(START, 'Qh5')).rejects.toThrow('not legal')
    } finally {
      await engine.close()
    }
  }, 60_000)

  test('concurrent grading matches serial grading', async () => {
    // Regression: the engine is one process behind one stdio pipe with no request
    // ids, so overlapping searches used to steal each other's output and return
    // confident, wrong scores rather than failing.
    const engine = stockfishEngine({ depth: 10 })
    await engine.ready()
    const grader = new Grader(engine, 10)
    const moves = ['e4', 'd4', 'Nf3', 'Nc3', 'c4', 'g3', 'b3', 'a4', 'h4', 'Nh3']
    try {
      const serial: number[] = []
      for (const san of moves) serial.push((await grader.grade(START, san)).cpl)

      const fresh = stockfishEngine({ depth: 10 })
      await fresh.ready()
      try {
        const freshGrader = new Grader(fresh, 10)
        const parallel = await Promise.all(moves.map((san) => freshGrader.grade(START, san)))
        expect(parallel.map((g) => g.cpl)).toEqual(serial)
      } finally {
        await fresh.close()
      }
    } finally {
      await engine.close()
    }
  }, 180_000)

  test('generated positions are legal, playable and reproducible from the seed', async () => {
    const engine = stockfishEngine({ depth: 8 })
    await engine.ready()
    try {
      const a = await generate(engine, { seed: 7, games: 2, playDepth: 4, atPlies: [9, 14] })
      const b = await generate(engine, { seed: 7, games: 2, playDepth: 4, atPlies: [9, 14] })
      expect(a.positions.map((p) => p.fen)).toEqual(b.positions.map((p) => p.fen))
      for (const p of a.positions) {
        const chess = new Chess(p.fen)
        expect(chess.isGameOver()).toBe(false)
        expect(chess.moves().length).toBeGreaterThan(1)
      }
    } finally {
      await engine.close()
    }
  }, 180_000)
})
