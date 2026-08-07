import { describe, expect, test } from 'bun:test'
import { matchFilename, slug } from './share'
import { DEFAULTS, type Settings } from './settings'

const withLabels = (a: string, b: string): Settings => {
  const s = structuredClone(DEFAULTS)
  s.players[0].label = a
  s.players[1].label = b
  return s
}

describe('slug', () => {
  test('reduces a label to something a filesystem will take', () => {
    expect(slug('GPT-5.6 Luna')).toBe('gpt-5-6-luna')
    expect(slug('  DeepSeek V4 Flash  ')).toBe('deepseek-v4-flash')
    expect(slug('anthropic/claude')).toBe('anthropic-claude')
  })

  test('falls back rather than producing an empty name', () => {
    expect(slug('???')).toBe('player')
    expect(slug('')).toBe('player')
  })
})

describe('matchFilename', () => {
  test('names the card and the video the same way', () => {
    const s = withLabels('Alpha One', 'Beta Two')
    expect(matchFilename(s, 'png')).toBe('grand-tensor-alpha-one-vs-beta-two.png')
    expect(matchFilename(s, 'webm')).toBe('grand-tensor-alpha-one-vs-beta-two.webm')
  })
})
