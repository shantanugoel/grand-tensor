import { describe, expect, test } from 'bun:test'
import { CIRCUITS } from './leaderboard-protocol'
import {
  currentMaxTokens,
  currentPromptTemplate,
  DEFAULT_PROMPT_TEMPLATE,
  DEFAULTS,
  effectiveSpeedIndex,
  LEGACY_DEFAULT_PROMPT_TEMPLATES,
} from './settings'

describe('currentPromptTemplate', () => {
  test('upgrades every stock prompt that has ever shipped', () => {
    expect(LEGACY_DEFAULT_PROMPT_TEMPLATES.length).toBeGreaterThan(0)
    for (const stock of LEGACY_DEFAULT_PROMPT_TEMPLATES)
      expect(currentPromptTemplate(stock)).toBe(DEFAULT_PROMPT_TEMPLATE)
  })

  test('preserves a genuinely edited prompt', () => {
    expect(currentPromptTemplate('My custom {{fen}} prompt')).toBe('My custom {{fen}} prompt')
    expect(currentPromptTemplate('')).toBe('')
  })

  test('never lists the current template as legacy, which would be a no-op cycle', () => {
    expect(LEGACY_DEFAULT_PROMPT_TEMPLATES).not.toContain(DEFAULT_PROMPT_TEMPLATE)
  })
})

describe('currentMaxTokens', () => {
  test('upgrades the previous stock cap but preserves a chosen one', () => {
    expect(currentMaxTokens(8000)).toBe(DEFAULTS.maxTokens)
    expect(currentMaxTokens(undefined)).toBe(DEFAULTS.maxTokens)
    expect(currentMaxTokens(4096)).toBe(4096)
    expect(currentMaxTokens(32000)).toBe(32000)
  })

  test('lands returning players on a circuit rather than outside every one', () => {
    expect(CIRCUITS.some((circuit) => circuit.maxTokens === currentMaxTokens(8000))).toBe(true)
  })
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
