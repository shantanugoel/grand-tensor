/** The downloadable match video.
 *
 *  Recording a match as it happens is not an option. An LLM turn takes two to
 *  four minutes, so a real four-game series is eight to forty hours of wall
 *  clock: tens of gigabytes, a tab that has to stay foregrounded the whole time,
 *  and an OOM long before the final position. The stored PGNs make all of that
 *  unnecessary — replayed through the same arena at Blitz, a whole series is
 *  about a minute of video and roughly 20 MB, which is also what X's 2:20 limit
 *  will take.
 *
 *  Frames come off the arena's own canvas. `Arena.onFrame` fires in the same task
 *  as the draw, which is the only moment a renderer with no preserved drawing
 *  buffer can be read back, and each one is composited into a fixed 1280x720
 *  canvas together with the scoreboard and the title cards. MediaRecorder
 *  captures that second canvas, so the file is the same size whatever the window
 *  happens to be, and the DOM overlay never leaks into the frame.
 *
 *  The container is whichever one the browser's recorder offers, MP4 for
 *  preference since that is what X will take an upload of, WebM where there is
 *  no MP4 recorder. Nothing is transcoded or remuxed here; the extension just
 *  follows what came out. */

import { Chess } from 'chess.js'
import { material, MAX_MATERIAL } from './adjudication'
import {
  CARD_MS,
  cardMsFor,
  estimateMs,
  plyMs,
  type CardSize,
  type CardTone,
  type CardView,
  type Storyboard,
} from './replay'
import { COLORS, fit, MONO, PIXEL } from './share-image'
import type { PlayerIdx } from './series'
import type { Arena } from './three/arena'

const W = 1280
const H = 720
const FPS = 30
/** ~22 MB for a minute — comfortably inside what X will accept, and small
 *  enough that the blob never becomes the memory problem live capture was. */
const BITRATE = 3_000_000
/** Cards fade rather than cut; a hard cut reads as a dropped frame. */
const FADE_MS = 220

/** Whatever container the browser's own recorder will hand over, best first.
 *
 *  MP4 leads for two reasons. X takes an MP4 upload and refuses a WebM, which
 *  makes it the postable one; and MediaRecorder muxes WebM live, so it never
 *  goes back to write a Duration into the Segment header — players are left to
 *  work the length out by scanning, and some just believe the missing header
 *  and report a second. MP4's header carries the real duration.
 *
 *  VP9 still compresses better per megabyte, so WebM stays as the fallback for
 *  browsers with no MP4 recorder (Firefox). What we never do is convert between
 *  them: no muxer ships with this. */
const MIME_CANDIDATES = [
  'video/mp4;codecs=avc1',
  'video/mp4',
  'video/webm;codecs=vp9',
  'video/webm;codecs=vp8',
  'video/webm',
]

const typeSupported = (type: string) =>
  typeof MediaRecorder === 'function' && MediaRecorder.isTypeSupported(type)

export function pickMimeType(
  supported: (type: string) => boolean = typeSupported,
  candidates: readonly string[] = MIME_CANDIDATES,
): string | null {
  return candidates.find(supported) ?? null
}

/** The file extension for whatever container we ended up with. Read off the
 *  recorded blob's own type rather than assumed, since which one we get is the
 *  browser's call. */
export function extensionFor(mimeType: string): string {
  return mimeType.split(';')[0].trim() === 'video/mp4' ? 'mp4' : 'webm'
}

/** Whether this browser can produce the file at all. A no here hides the button
 *  rather than letting the export fail halfway through a replay. */
export function canRecordVideo(): boolean {
  return (
    typeof MediaRecorder === 'function' &&
    typeof HTMLCanvasElement === 'function' &&
    typeof HTMLCanvasElement.prototype.captureStream === 'function' &&
    pickMimeType() !== null
  )
}

/* ---------- the composited frame ---------- */

type HudView = {
  names: [string, string]
  score: [string, string]
  /** "GAME 2 / 4". */
  chapter: string
  /** "MOVE 17", or empty where there is no move to count. */
  move: string
  white: PlayerIdx
  /** Remaining material per player — the vitality bars' "health". */
  hp: [number, number]
  totalGames: number
}

/* The vitality bars, the same arcade read as the live overlay: a socket holding
   a slow red "chip damage" layer under the fast vitality layer. The DOM does the
   lag with CSS transitions; here it is a per-frame decay, since the recorder
   only ever sees what this canvas was told to paint. */
const BAR = { w: 420, h: 18, y: 78, x: 44 }
/** Held after a capture before the red starts to drain, then material a second. */
const CHIP_HOLD_MS = 350
const CHIP_RATE = 15 / 1000
const DANGER = 0.25

const FONT: Record<CardSize, string> = {
  hero: `38px ${PIXEL}`,
  title: `20px ${PIXEL}`,
  label: `12px ${PIXEL}`,
  note: `17px ${MONO}`,
}

const LINE_H: Record<CardSize, number> = { hero: 82, title: 44, label: 36, note: 32 }

const TONE: Record<CardTone, string> = {
  p0: COLORS.p0,
  p1: COLORS.p1,
  gold: COLORS.gold,
  text: COLORS.text,
  dim: COLORS.dim,
}

class Frame {
  readonly canvas = document.createElement('canvas')
  private ctx: CanvasRenderingContext2D
  private card: { view: CardView; start: number; ms: number } | null = null
  /** The trailing red layer, and when it may start catching up. */
  private chip: [number, number]
  private chipAt: [number, number] = [0, 0]
  private chipTs = performance.now()

  constructor(private hud: HudView) {
    this.canvas.width = W
    this.canvas.height = H
    this.ctx = this.canvas.getContext('2d', { alpha: false })!
    this.chip = [...hud.hp]
  }

  setHud(patch: Partial<HudView>) {
    const before = this.hud.hp
    this.hud = { ...this.hud, ...patch }
    this.hud.hp.forEach((hp, i) => {
      // A capture opens a gap the red drains across; a reset back up to a full
      // board is a new game, not damage, so the chip snaps with it.
      if (hp > before[i]) this.chip[i] = hp
      else if (hp < before[i]) this.chipAt[i] = performance.now() + CHIP_HOLD_MS
    })
  }

  showCard(view: CardView, ms: number) {
    this.card = { view, start: performance.now(), ms }
  }

  clearCard() {
    this.card = null
  }

  /** Called once per arena frame, inside the arena's own render task. */
  draw(source: HTMLCanvasElement) {
    this.drawArena(source)
    this.drawHud()
    if (this.card) {
      const alpha = fadeAlpha(performance.now() - this.card.start, this.card.ms)
      if (alpha > 0) this.drawCard(this.card.view, alpha)
    }
  }

  private drawArena(src: HTMLCanvasElement) {
    const ctx = this.ctx
    ctx.fillStyle = COLORS.bg
    ctx.fillRect(0, 0, W, H)
    if (!src.width || !src.height) return
    // Crop to fill: a portrait window frames the board with a lot of empty sky,
    // and taking 16:9 out of the middle of that is the better shot anyway.
    const scale = Math.max(W / src.width, H / src.height)
    const w = src.width * scale
    const h = src.height * scale
    ctx.drawImage(src, (W - w) / 2, (H - h) / 2, w, h)
  }

  private drawHud() {
    const ctx = this.ctx
    const hud = this.hud

    const top = ctx.createLinearGradient(0, 0, 0, 176)
    top.addColorStop(0, 'rgba(6, 8, 16, 0.86)')
    top.addColorStop(0.6, 'rgba(6, 8, 16, 0.6)')
    top.addColorStop(1, 'rgba(6, 8, 16, 0)')
    ctx.fillStyle = top
    ctx.fillRect(0, 0, W, 176)

    const bottom = ctx.createLinearGradient(0, H - 160, 0, H)
    bottom.addColorStop(0, 'rgba(6, 8, 16, 0)')
    bottom.addColorStop(1, 'rgba(6, 8, 16, 0.94)')
    ctx.fillStyle = bottom
    ctx.fillRect(0, H - 160, W, 160)

    ctx.textBaseline = 'middle'

    // The ▚ mark is drawn rather than typed — the pixel face has no glyph for it.
    ctx.fillStyle = COLORS.p0
    ctx.fillRect(44, 34, 8, 8)
    ctx.fillRect(52, 42, 8, 8)
    ctx.font = `15px ${PIXEL}`
    ctx.textAlign = 'left'
    ctx.fillText('GRAND TENSOR', 72, 44)

    ctx.font = `11px ${PIXEL}`
    ctx.fillStyle = COLORS.dim
    ctx.textAlign = 'right'
    ctx.fillText(hud.chapter, W - 44, 44)

    this.drawKoMeter()

    const nameY = H - 86
    ctx.font = `16px ${PIXEL}`
    ctx.textAlign = 'left'
    ctx.fillStyle = COLORS.p0
    ctx.fillText(fit(ctx, hud.names[0], 400), 44, nameY)
    ctx.textAlign = 'right'
    ctx.fillStyle = COLORS.p1
    ctx.fillText(fit(ctx, hud.names[1], 400), W - 44, nameY)

    ctx.font = `10px ${PIXEL}`
    ctx.fillStyle = COLORS.dim
    ctx.textAlign = 'left'
    ctx.fillText(hud.white === 0 ? 'WHITE' : 'BLACK', 44, nameY + 32)
    ctx.textAlign = 'right'
    ctx.fillText(hud.white === 1 ? 'WHITE' : 'BLACK', W - 44, nameY + 32)

    ctx.textAlign = 'center'
    ctx.font = `30px ${PIXEL}`
    ctx.fillStyle = COLORS.gold
    ctx.fillText(`${hud.score[0]} – ${hud.score[1]}`, W / 2, nameY)

    if (hud.move) {
      ctx.font = `13px ${MONO}`
      ctx.fillStyle = COLORS.dim
      ctx.fillText(hud.move, W / 2, nameY + 32)
    }
  }

  /** Vitality bars and win stars, mirroring the live overlay's arcade header. */
  private drawKoMeter() {
    const ctx = this.ctx
    const now = performance.now()
    const dt = Math.max(0, Math.min(200, now - this.chipTs))
    this.chipTs = now

    for (const i of [0, 1] as const) {
      const hp = this.hud.hp[i]
      if (now >= this.chipAt[i]) this.chip[i] = Math.max(hp, this.chip[i] - CHIP_RATE * dt)
      const left = i === 0
      const x = left ? BAR.x : W - BAR.x - BAR.w
      const frac = clamp01(hp / MAX_MATERIAL)
      const chipFrac = clamp01(this.chip[i] / MAX_MATERIAL)

      ctx.font = `10px ${PIXEL}`
      ctx.fillStyle = COLORS.dim
      ctx.textAlign = left ? 'right' : 'left'
      ctx.fillText(String(hp), left ? x + BAR.w : x, BAR.y - 12)

      // Socket, then the red under the vitality layer — both grow from the
      // player's own outer edge, so the two bars drain towards the middle.
      ctx.fillStyle = '#10152a'
      ctx.fillRect(x, BAR.y, BAR.w, BAR.h)

      const band = (fraction: number, stops: [number, string][]) => {
        const w = BAR.w * fraction
        if (w <= 0) return
        const grad = ctx.createLinearGradient(0, BAR.y, 0, BAR.y + BAR.h)
        for (const [at, color] of stops) grad.addColorStop(at, color)
        ctx.fillStyle = grad
        ctx.fillRect(left ? x : x + BAR.w - w, BAR.y, w, BAR.h)
      }

      band(chipFrac, [
        [0, '#ff8a8a'],
        [1, '#e03636'],
      ])
      band(
        frac,
        frac < DANGER
          ? [
              [0, '#ff9a6a'],
              [0.45, '#ff4d4d'],
              [1, '#b81616'],
            ]
          : [
              [0, '#ffe97a'],
              [0.42, '#ffc93c'],
              [0.43, '#f59218'],
              [1, '#e0620c'],
            ],
      )

      // Under a quarter health the bar flashes, on the same two-step beat the
      // overlay's CSS animation runs at.
      if (frac < DANGER && Math.floor(now / 275) % 2) {
        ctx.fillStyle = 'rgba(255, 255, 255, 0.22)'
        ctx.fillRect(left ? x : x + BAR.w - BAR.w * frac, BAR.y, BAR.w * frac, BAR.h)
      }

      ctx.strokeStyle = COLORS.line
      ctx.lineWidth = 2
      ctx.strokeRect(x - 1, BAR.y - 1, BAR.w + 2, BAR.h + 2)

      // Half a point is a draw, and rounding it away would lose the only mark a
      // drawn game leaves on the header.
      const score = Number(this.hud.score[i]) || 0
      const full = Math.floor(score)
      const half = score % 1 !== 0
      const starY = BAR.y + BAR.h + 10
      for (let n = 0; n < this.hud.totalGames; n++) {
        const sx = left
          ? x + n * 15
          : x + BAR.w - 11 - (this.hud.totalGames - 1 - n) * 15
        const state = n < full ? 'won' : n === full && half ? 'half' : 'empty'
        ctx.fillStyle = state === 'empty' ? 'rgba(255, 255, 255, 0.16)' : COLORS.gold
        if (state === 'half') {
          ctx.save()
          ctx.beginPath()
          ctx.rect(sx, starY, 5.5, 11)
          ctx.clip()
          drawStar(ctx, sx, starY, 11)
          ctx.restore()
          ctx.fillStyle = 'rgba(255, 255, 255, 0.16)'
          ctx.save()
          ctx.beginPath()
          ctx.rect(sx + 5.5, starY, 5.5, 11)
          ctx.clip()
          drawStar(ctx, sx, starY, 11)
          ctx.restore()
        } else {
          drawStar(ctx, sx, starY, 11)
        }
      }
    }
  }

  private drawCard(view: CardView, alpha: number) {
    const ctx = this.ctx
    ctx.save()
    ctx.globalAlpha = alpha
    ctx.fillStyle = 'rgba(6, 8, 16, 0.9)'
    ctx.fillRect(0, 0, W, H)
    ctx.strokeStyle = COLORS.line
    ctx.lineWidth = 1
    ctx.strokeRect(40.5, 40.5, W - 81, H - 81)

    const height = view.lines.reduce((n, line) => n + LINE_H[line.size], 0)
    let y = (H - height) / 2
    ctx.textAlign = 'center'
    ctx.textBaseline = 'middle'
    for (const line of view.lines) {
      const h = LINE_H[line.size]
      ctx.font = FONT[line.size]
      ctx.fillStyle = TONE[line.tone]
      ctx.fillText(fit(ctx, line.text, W - 140), W / 2, y + h / 2)
      y += h
    }
    ctx.restore()
  }
}

const clamp01 = (n: number) => Math.max(0, Math.min(1, n))

/** The same five-pointed outline the overlay's stars are clipped to. */
const STAR = [
  [50, 0], [61, 35], [98, 35], [68, 57], [79, 91],
  [50, 70], [21, 91], [32, 57], [2, 35], [39, 35],
] as const

function drawStar(ctx: CanvasRenderingContext2D, x: number, y: number, size: number) {
  ctx.beginPath()
  STAR.forEach(([px, py], i) => {
    const sx = x + (px / 100) * size
    const sy = y + (py / 100) * size
    if (i === 0) ctx.moveTo(sx, sy)
    else ctx.lineTo(sx, sy)
  })
  ctx.closePath()
  ctx.fill()
}

/** Ramp in, hold, ramp out. */
export function fadeAlpha(elapsed: number, total: number, fade = FADE_MS): number {
  if (elapsed <= 0) return 0
  if (elapsed >= total) return 0
  const ramp = Math.min(fade, total / 2)
  if (elapsed < ramp) return elapsed / ramp
  if (elapsed > total - ramp) return (total - elapsed) / ramp
  return 1
}

/* ---------- the recording ---------- */

export type ExportProgress = { fraction: number; label: string }

export type RecordRequest = {
  arena: Arena
  storyboard: Storyboard
  /** Arena.speed for the replay. The caller sets it; this only needs it to
   *  weight the progress bar. */
  anim: number
  onProgress: (p: ExportProgress) => void
  signal: AbortSignal
}

/** Replays the series and returns the encoded file. Null means cancelled. */
export async function recordSeriesVideo(req: RecordRequest): Promise<Blob | null> {
  const mimeType = pickMimeType()
  if (!mimeType) throw new Error('this browser has no canvas recorder')

  // Without this the first export of a session silently falls back to the
  // generic monospace for every label on the overlay.
  await document.fonts?.ready?.catch?.(() => {})

  const { arena, storyboard: story, signal } = req
  const frame = new Frame({
    names: story.names,
    score: ['0', '0'],
    chapter: `BEST OF ${story.totalGames}`,
    move: '',
    white: 0,
    hp: [MAX_MATERIAL, MAX_MATERIAL],
    totalGames: story.totalGames,
  })

  const stream = frame.canvas.captureStream(FPS)
  const recorder = new MediaRecorder(stream, { mimeType, videoBitsPerSecond: BITRATE })
  const chunks: Blob[] = []
  let failure: Error | null = null

  recorder.ondataavailable = (e) => {
    if (e.data.size) chunks.push(e.data)
  }
  recorder.onerror = () => {
    failure ??= new Error('the recorder stopped unexpectedly')
  }
  const stopped = new Promise<void>((resolve) => {
    recorder.onstop = () => resolve()
  })

  arena.onFrame = (canvas) => frame.draw(canvas)
  // A timeslice keeps the encoder handing back finished chunks instead of
  // holding the whole match in one buffer until stop().
  recorder.start(1000)

  try {
    await play(req, frame)
  } finally {
    arena.onFrame = null
    if (recorder.state !== 'inactive') recorder.stop()
    await stopped
    stream.getTracks().forEach((track) => track.stop())
  }

  if (failure) throw failure
  if (signal.aborted) return null
  return new Blob(chunks, { type: mimeType })
}

async function play(req: RecordRequest, frame: Frame) {
  const { arena, storyboard: story, anim, onProgress, signal } = req
  const cardMs = cardMsFor(story.games.length)
  const totalMs = estimateMs(story.totalPlies, cardMs, anim)
  const perPly = plyMs(anim)
  let elapsed = 0
  let label = 'Setting the scene…'

  const report = (ms: number) => {
    elapsed += ms
    onProgress({ fraction: Math.min(1, elapsed / totalMs), label })
  }

  /** `duringHold` runs once the card is fully opaque. Rearranging the board in
   *  the gap between two cards would show the position being replaced for a
   *  frame — which, at the top of the video, is the last game's final position
   *  giving the whole series away. */
  const card = async (view: CardView, ms: number, duringHold?: () => void) => {
    frame.showCard(view, ms)
    if (duringHold) {
      const opaque = Math.min(FADE_MS, ms / 2)
      await sleep(opaque, signal)
      duringHold()
      await sleep(ms - opaque, signal)
    } else {
      await sleep(ms, signal)
    }
    frame.clearCard()
    report(ms)
  }

  // Nothing has rendered through the capture yet — the arena is still holding
  // the position the series ended on.
  arena.setPosition(new Chess())
  onProgress({ fraction: 0, label })
  await card(story.intro, CARD_MS.intro)
  if (signal.aborted) return

  for (const game of story.games) {
    const chess = new Chess()
    frame.setHud({
      white: game.white,
      score: game.scoreBefore,
      chapter: `GAME ${game.index + 1} / ${story.totalGames}`,
      move: '',
      hp: [MAX_MATERIAL, MAX_MATERIAL],
    })
    label = `Game ${game.index + 1} of ${story.games.length}`
    await card(game.intro, CARD_MS.gameIntro, () => arena.setPosition(chess))
    if (signal.aborted) return

    for (const [i, san] of game.moves.entries()) {
      // chess.js throws on a move the position doesn't allow. A stored PGN that
      // stops matching is a corrupt record, not a reason to abandon the file —
      // cut to the result card and carry on with the next game.
      let move
      try {
        move = chess.move(san)
      } catch {
        break
      }
      const hp: [number, number] = [0, 0]
      hp[game.white] = material(chess, 'w')
      hp[1 - game.white] = material(chess, 'b')
      frame.setHud({ move: `MOVE ${Math.ceil((i + 1) / 2)}`, hp })
      await arena.animateMove(move, chess, { check: chess.isCheck(), mate: chess.isCheckmate() })
      label = `Game ${game.index + 1} of ${story.games.length} · move ${Math.ceil((i + 1) / 2)}`
      report(perPly)
      if (signal.aborted) return
    }

    frame.setHud({ score: game.scoreAfter, move: '' })
    await card(game.outro, CARD_MS.gameOutro)
    if (signal.aborted) return
  }

  label = 'Finishing up…'
  await card(story.outro, CARD_MS.outro)
}

function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    const done = () => (clearTimeout(timer), signal.removeEventListener('abort', done), resolve())
    const timer = setTimeout(done, ms)
    signal.addEventListener('abort', done)
  })
}
