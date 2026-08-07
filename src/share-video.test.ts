import { describe, expect, test } from 'bun:test'
import { extensionFor, fadeAlpha, pickMimeType } from './share-video'

describe('pickMimeType', () => {
  test('prefers VP9, then VP8, then bare WebM', () => {
    expect(pickMimeType(() => true)).toBe('video/webm;codecs=vp9')
    expect(pickMimeType((t) => !t.includes('vp9'))).toBe('video/webm;codecs=vp8')
    expect(pickMimeType((t) => t === 'video/webm')).toBe('video/webm')
  })

  test('takes the MP4 Safari offers rather than recording nothing', () => {
    // Safari's MediaRecorder speaks no WebM at all. Its own MP4 is free; what
    // we won't do is convert one into the other.
    expect(pickMimeType((t) => t.startsWith('video/mp4'))).toBe('video/mp4;codecs=avc1')
    expect(pickMimeType((t) => t === 'video/mp4')).toBe('video/mp4')
  })

  test('prefers WebM over MP4 where a browser records both', () => {
    expect(pickMimeType(() => true)?.startsWith('video/webm')).toBe(true)
  })

  test('gives up when nothing is on offer', () => {
    expect(pickMimeType(() => false)).toBeNull()
  })
})

describe('extensionFor', () => {
  test('follows the container the recorder actually produced', () => {
    expect(extensionFor('video/webm;codecs=vp9')).toBe('webm')
    expect(extensionFor('video/webm')).toBe('webm')
    expect(extensionFor('video/mp4;codecs=avc1')).toBe('mp4')
    expect(extensionFor('video/mp4')).toBe('mp4')
  })

  test('falls back to webm on a type it does not recognise', () => {
    expect(extensionFor('')).toBe('webm')
    expect(extensionFor('video/x-matroska;codecs=avc1')).toBe('webm')
  })
})

describe('fadeAlpha', () => {
  test('ramps in, holds, ramps out', () => {
    expect(fadeAlpha(0, 1000, 200)).toBe(0)
    expect(fadeAlpha(100, 1000, 200)).toBe(0.5)
    expect(fadeAlpha(500, 1000, 200)).toBe(1)
    expect(fadeAlpha(900, 1000, 200)).toBeCloseTo(0.5, 5)
    expect(fadeAlpha(1000, 1000, 200)).toBe(0)
  })

  test('splits the hold out of a card too short to fade twice', () => {
    // A 200ms card with a 200ms ramp would otherwise fade in past full opacity.
    expect(fadeAlpha(100, 200, 200)).toBe(1)
    expect(fadeAlpha(50, 200, 200)).toBe(0.5)
    expect(fadeAlpha(150, 200, 200)).toBe(0.5)
  })

  test('is blank outside the card', () => {
    expect(fadeAlpha(-50, 1000, 200)).toBe(0)
    expect(fadeAlpha(1500, 1000, 200)).toBe(0)
  })
})
