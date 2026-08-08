import { describe, expect, test } from 'bun:test'
import {
  classifyLoss,
  fmtEval,
  fmtSwing,
  MATE_CP,
  readEval,
  storeEval,
  TAG_COLOR,
  TAG_LABEL,
  TAG_SHOUT,
  TAG_VOLUME,
  type EvalTag,
  type MoveEval,
} from './verdict'

const TAGS: EvalTag[] = ['mate', 'best', 'good', 'inaccuracy', 'mistake', 'blunder', 'catastrophe']

describe('bands', () => {
  test('name a loss the way a chess player would', () => {
    expect(classifyLoss(0)).toBe('best')
    expect(classifyLoss(20)).toBe('best')
    expect(classifyLoss(21)).toBe('good')
    expect(classifyLoss(69)).toBe('good')
    expect(classifyLoss(70)).toBe('inaccuracy')
    expect(classifyLoss(150)).toBe('mistake')
    expect(classifyLoss(300)).toBe('blunder')
    expect(classifyLoss(600)).toBe('catastrophe')
  })

  test('a move that loses nothing is the best one, not a special case', () => {
    // Centipawn loss is measured against the engine's own choice, so it cannot
    // go below zero — there is no band under `best` and nothing to name it.
    expect(classifyLoss(0)).toBe('best')
  })
})

describe('the vocabulary tables', () => {
  test('cover every tag, so a new one cannot render as undefined', () => {
    for (const tag of TAGS) {
      expect(TAG_LABEL[tag]).toBeDefined()
      expect(TAG_SHOUT[tag]).toBeDefined()
      expect(TAG_VOLUME[tag]).toBeDefined()
      expect(TAG_COLOR[tag]).toBeDefined()
    }
    expect(Object.keys(TAG_LABEL).sort()).toEqual([...TAGS].sort())
  })

  test('stay quiet about the moves that are merely fine', () => {
    expect(TAG_LABEL.best).toBe('')
    expect(TAG_LABEL.good).toBe('')
    expect(TAG_SHOUT.best).toEqual([])
    expect(TAG_SHOUT.inaccuracy).toEqual([])
    expect(TAG_LABEL.blunder).toBe('BLUNDER')
  })

  test('get louder as the move gets worse', () => {
    expect(TAG_VOLUME.catastrophe).toBeGreaterThan(TAG_VOLUME.blunder)
    expect(TAG_VOLUME.blunder).toBeGreaterThan(TAG_VOLUME.mistake)
  })
})

describe('formatting', () => {
  test('reads a score the way a broadcast prints it', () => {
    expect(fmtEval({ cp: 0, mate: false, draw: false })).toBe('0.00')
    expect(fmtEval({ cp: 135, mate: false, draw: false })).toBe('+1.35')
    expect(fmtEval({ cp: -135, mate: false, draw: false })).toBe('−1.35')
    expect(fmtEval({ cp: 0, mate: true, draw: false })).toBe('MATE')
    expect(fmtEval({ cp: 0, mate: false, draw: true })).toBe('DRAW')
  })

  test('signs a swing against whoever played it', () => {
    expect(fmtSwing(250)).toBe('−2.5')
    expect(fmtSwing(0)).toBe('+0.0')
  })
})

describe('storing a verdict beside its game', () => {
  const verdict: MoveEval = { cp: -212, mate: false, draw: false, loss: 340, tag: 'blunder' }

  test('keeps only what cannot be derived again', () => {
    expect(storeEval(verdict)).toEqual([-212, 340])
  })

  test('comes back as the verdict that went in', () => {
    const back = readEval(storeEval(verdict), { mate: false, draw: false }, 'w')
    expect(back).toEqual(verdict)
  })

  test('rounds, so a stored series is not full of float noise', () => {
    expect(storeEval({ ...verdict, cp: -212.4, loss: 340.6 })).toEqual([-212, 341])
  })

  test('scores a mate for whoever delivered it, whatever the search said', () => {
    const white = readEval([900, 0], { mate: true, draw: false }, 'w')
    expect(white).toMatchObject({ tag: 'mate', mate: true, cp: MATE_CP, loss: 0 })
    expect(readEval([900, 0], { mate: true, draw: false }, 'b').cp).toBe(-MATE_CP)
  })

  test('a drawn position is level however the move was graded', () => {
    const drawn = readEval([420, 30], { mate: false, draw: true }, 'b')
    expect(drawn).toMatchObject({ cp: 0, draw: true, tag: 'good' })
  })
})
