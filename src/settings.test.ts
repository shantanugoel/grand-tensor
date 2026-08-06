import { describe, expect, test } from 'bun:test'
import { currentPromptTemplate, DEFAULT_PROMPT_TEMPLATE, DEFAULTS, effectiveSpeedIndex } from './settings'

describe('currentPromptTemplate', () => {
  test('upgrades the previous stock prompt but preserves custom prompts', () => {
    const previousStock = DEFAULT_PROMPT_TEMPLATE.replace(
      'playing a game of chess as {{color}}',
      'playing {{color}}',
    )

    expect(currentPromptTemplate(previousStock)).toBe(DEFAULT_PROMPT_TEMPLATE)
    expect(currentPromptTemplate('My custom {{fen}} prompt')).toBe('My custom {{fen}} prompt')
    expect(currentPromptTemplate('')).toBe('')
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
