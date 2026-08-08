import { describe, expect, test } from 'bun:test'
import { DEFAULTS, effectiveSpeedIndex, normalizeReasoningEffort, SPEEDS } from './settings'

test('normalizes the provider spelling for disabled reasoning', () => {
  expect(normalizeReasoningEffort('none')).toBe('off')
  expect(normalizeReasoningEffort('low')).toBe('low')
})

describe('effectiveSpeedIndex', () => {
  test('paces an all-random Turbo demo like Blitz', () => {
    const demo = structuredClone(DEFAULTS)
    demo.speed = 0
    demo.players[0].model = 'random'
    demo.players[1].model = ' RANDOM '
    expect(effectiveSpeedIndex(demo)).toBe(1)
  })

  test('leaves API matches and non-Turbo demo speeds unchanged', () => {
    expect(effectiveSpeedIndex(DEFAULTS)).toBe(DEFAULTS.speed)

    const demo = structuredClone(DEFAULTS)
    demo.speed = 2
    demo.players[0].model = 'random'
    demo.players[1].model = 'random'
    expect(effectiveSpeedIndex(demo)).toBe(2)
  })
})

test('every match speed keeps piece movement visible', () => {
  expect(SPEEDS.every((speed) => speed.anim > 0)).toBe(true)
  expect(SPEEDS.map((speed) => speed.anim)).toEqual([...SPEEDS.map((speed) => speed.anim)].sort((a, b) => a - b))
})
