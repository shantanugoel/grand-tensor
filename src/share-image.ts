/** The shareable result card, drawn on a canvas.
 *
 *  Everything is painted by hand rather than rasterising the DOM: the page's CSP
 *  rules out a screenshot library, and a fixed 1200×675 card posts far better
 *  than a crop of whatever the window happened to look like. The arena still
 *  makes it in — `Arena.snapshot()` supplies the board band at the top. */

import type { Series } from './series'
import type { Settings } from './settings'
import { fmtScore, shareUrl } from './share'

const W = 1200
const H = 675
/** Where the arena band ends and the scoreboard begins. */
const BAND = 258

const COLORS = {
  bg: '#060810',
  panel: '#0b0f1c',
  line: 'rgba(122, 160, 255, 0.18)',
  text: '#dbe4ff',
  dim: '#7d8bb5',
  gold: '#ffd54a',
  p0: '#4de3ff',
  p1: '#ff5fd2',
}

const PIXEL = `'Press Start 2P', ui-monospace, monospace`
const MONO = `'JetBrains Mono', ui-monospace, monospace`

const fmtTokens = (n: number) =>
  n >= 1_000_000 ? `${(n / 1_000_000).toFixed(1)}M` : n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n)

const fmtCost = (n: number) => (n > 0 ? `$${n < 0.01 ? n.toFixed(4) : n.toFixed(2)}` : '—')

const fmtMs = (n: number) => (n >= 1000 ? `${(n / 1000).toFixed(1)}s` : `${Math.round(n)}ms`)

function loadImage(src: string): Promise<HTMLImageElement | null> {
  return new Promise((resolve) => {
    const img = new Image()
    img.onload = () => resolve(img)
    img.onerror = () => resolve(null)
    img.src = src
  })
}

/** Trims with an ellipsis so a long model id can't run off the card. */
function fit(ctx: CanvasRenderingContext2D, text: string, max: number): string {
  if (ctx.measureText(text).width <= max) return text
  let out = text
  while (out.length > 1 && ctx.measureText(`${out}…`).width > max) out = out.slice(0, -1)
  return `${out}…`
}

function roundRect(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number) {
  ctx.beginPath()
  ctx.roundRect(x, y, w, h, r)
}

/** Draws the arena still cropped-to-fill, then fades it into the card. */
function drawBand(ctx: CanvasRenderingContext2D, board: HTMLImageElement | null) {
  if (board && board.width && board.height) {
    const scale = Math.max(W / board.width, BAND / board.height)
    const w = board.width * scale
    const h = board.height * scale
    ctx.save()
    roundRect(ctx, 0, 0, W, BAND, 0)
    ctx.clip()
    ctx.drawImage(board, (W - w) / 2, (BAND - h) / 2, w, h)
    ctx.restore()
  } else {
    const glow = ctx.createRadialGradient(W / 2, BAND * 0.4, 20, W / 2, BAND * 0.4, W * 0.6)
    glow.addColorStop(0, 'rgba(77, 227, 255, 0.20)')
    glow.addColorStop(1, 'rgba(6, 8, 16, 0)')
    ctx.fillStyle = glow
    ctx.fillRect(0, 0, W, BAND)
  }

  // Scrim at the top so the wordmark stays readable over a busy board, and a
  // fade at the bottom so the band dissolves into the scoreboard.
  const top = ctx.createLinearGradient(0, 0, 0, 110)
  top.addColorStop(0, 'rgba(6, 8, 16, 0.85)')
  top.addColorStop(1, 'rgba(6, 8, 16, 0)')
  ctx.fillStyle = top
  ctx.fillRect(0, 0, W, 110)

  const bottom = ctx.createLinearGradient(0, BAND - 150, 0, BAND)
  bottom.addColorStop(0, 'rgba(6, 8, 16, 0)')
  bottom.addColorStop(1, COLORS.bg)
  ctx.fillStyle = bottom
  ctx.fillRect(0, BAND - 150, W, 150)
}

/** One square per game, coloured by who took it — the same alphabet as the
 *  copied text, so the two summaries read alike. */
function drawPips(ctx: CanvasRenderingContext2D, series: Series, y: number) {
  const total = Math.max(series.totalGames, series.games.length)
  const size = total > 20 ? 14 : 22
  const gap = total > 20 ? 5 : 8
  const width = total * size + (total - 1) * gap
  let x = (W - width) / 2

  for (let i = 0; i < total; i++) {
    const rec = series.games[i]
    if (!rec) ctx.fillStyle = 'rgba(255, 255, 255, 0.07)'
    else if (rec.result === '1/2-1/2') ctx.fillStyle = COLORS.dim
    else ctx.fillStyle = (rec.result === '1-0' ? rec.white : 1 - rec.white) === 0 ? COLORS.p0 : COLORS.p1
    roundRect(ctx, x, y, size, size, 4)
    ctx.fill()
    if (!rec) {
      ctx.strokeStyle = COLORS.line
      ctx.lineWidth = 1
      ctx.stroke()
    }
    x += size + gap
  }
}

type Row = { label: string; a: string; b: string }

function statRows(series: Series): Row[] {
  const [a, b] = series.stats
  return [
    { label: 'W / D / L', a: `${a.wins}/${a.draws}/${a.losses}`, b: `${b.wins}/${b.draws}/${b.losses}` },
    { label: 'MOVES', a: String(a.moves), b: String(b.moves) },
    { label: 'TOKENS', a: fmtTokens(a.usage.total), b: fmtTokens(b.usage.total) },
    { label: 'ILLEGAL', a: String(a.illegal), b: String(b.illegal) },
    {
      label: 'AVG THINK',
      a: a.turns ? fmtMs(a.totalMs / a.turns) : '—',
      b: b.turns ? fmtMs(b.totalMs / b.turns) : '—',
    },
    { label: 'COST', a: fmtCost(a.usage.cost), b: fmtCost(b.usage.cost) },
  ]
}

function drawTable(ctx: CanvasRenderingContext2D, series: Series, top: number) {
  const rows = statRows(series)
  const rowH = 26
  const height = rows.length * rowH + 16

  ctx.fillStyle = 'rgba(122, 160, 255, 0.04)'
  roundRect(ctx, 90, top, W - 180, height, 14)
  ctx.fill()
  ctx.strokeStyle = COLORS.line
  ctx.lineWidth = 1
  ctx.stroke()

  rows.forEach((row, i) => {
    const y = top + 8 + i * rowH + rowH / 2

    ctx.font = `10px ${PIXEL}`
    ctx.fillStyle = COLORS.dim
    ctx.textAlign = 'center'
    ctx.textBaseline = 'middle'
    ctx.fillText(row.label, W / 2, y)

    ctx.font = `600 15px ${MONO}`
    ctx.fillStyle = COLORS.p0
    ctx.textAlign = 'right'
    ctx.fillText(row.a, W / 2 - 110, y)

    ctx.fillStyle = COLORS.p1
    ctx.textAlign = 'left'
    ctx.fillText(row.b, W / 2 + 110, y)
  })
}

/** Renders the whole card. `boardPng` is an optional arena still (a data URL). */
export async function renderResultCard(
  series: Series,
  settings: Settings,
  boardPng: string | null,
): Promise<HTMLCanvasElement> {
  // The pixel and mono faces come from a webfont; without this the first card of
  // a session silently falls back to the generic monospace.
  await document.fonts?.ready?.catch?.(() => {})

  const canvas = document.createElement('canvas')
  canvas.width = W
  canvas.height = H
  const ctx = canvas.getContext('2d')!

  ctx.fillStyle = COLORS.bg
  ctx.fillRect(0, 0, W, H)

  drawBand(ctx, boardPng ? await loadImage(boardPng) : null)

  ctx.textBaseline = 'middle'

  /* wordmark — the ▚ mark is drawn rather than typed; the pixel face has no
     glyph for it and falls back to a tofu box. */
  ctx.fillStyle = COLORS.p0
  ctx.fillRect(60, 42, 9, 9)
  ctx.fillRect(69, 51, 9, 9)
  ctx.font = `18px ${PIXEL}`
  ctx.textAlign = 'left'
  ctx.fillText('GRAND TENSOR', 92, 52)
  ctx.font = `10px ${PIXEL}`
  ctx.fillStyle = COLORS.dim
  ctx.textAlign = 'right'
  ctx.fillText(`BEST OF ${settings.games}`, W - 60, 52)

  /* names, models, score */
  const [a, b] = series.stats
  const nameY = BAND + 52
  ctx.font = `16px ${PIXEL}`
  ctx.textAlign = 'left'
  ctx.fillStyle = COLORS.p0
  ctx.fillText(fit(ctx, settings.players[0].label, 380), 60, nameY)
  ctx.textAlign = 'right'
  ctx.fillStyle = COLORS.p1
  ctx.fillText(fit(ctx, settings.players[1].label, 380), W - 60, nameY)

  ctx.font = `13px ${MONO}`
  ctx.fillStyle = COLORS.dim
  ctx.textAlign = 'left'
  ctx.fillText(fit(ctx, settings.players[0].model, 380), 60, nameY + 26)
  ctx.textAlign = 'right'
  ctx.fillText(fit(ctx, settings.players[1].model, 380), W - 60, nameY + 26)

  ctx.font = `34px ${PIXEL}`
  ctx.fillStyle = COLORS.gold
  ctx.textAlign = 'center'
  ctx.fillText(`${fmtScore(a.score)} – ${fmtScore(b.score)}`, W / 2, nameY + 10)

  drawPips(ctx, series, BAND + 100)

  /* verdict */
  const leader = series.leader
  ctx.font = `13px ${PIXEL}`
  ctx.fillStyle = leader === null ? COLORS.text : leader === 0 ? COLORS.p0 : COLORS.p1
  ctx.textAlign = 'center'
  ctx.fillText(
    leader === null
      ? `DEAD HEAT AFTER ${series.games.length}`
      : fit(ctx, `${settings.players[leader].label.toUpperCase()} TAKES THE CROWN`, W - 160),
    W / 2,
    BAND + 160,
  )

  drawTable(ctx, series, BAND + 186)

  /* footer */
  ctx.font = `13px ${MONO}`
  ctx.fillStyle = COLORS.dim
  ctx.textAlign = 'center'
  ctx.fillText(fit(ctx, shareUrl(settings), W - 120), W / 2, H - 32)

  /* frame */
  ctx.strokeStyle = COLORS.line
  ctx.lineWidth = 2
  ctx.strokeRect(1, 1, W - 2, H - 2)

  return canvas
}

function toBlob(canvas: HTMLCanvasElement): Promise<Blob | null> {
  return new Promise((resolve) => canvas.toBlob(resolve, 'image/png'))
}

export type ImageShareResult = 'copied' | 'downloaded' | 'failed'

/** Copies the card to the clipboard, falling back to a download where the
 *  async clipboard has no image support (Firefox, insecure contexts). */
export async function copyImage(canvas: HTMLCanvasElement, filename: string): Promise<ImageShareResult> {
  const blob = await toBlob(canvas)
  if (!blob) return 'failed'

  if (typeof ClipboardItem === 'function' && navigator.clipboard?.write) {
    try {
      await navigator.clipboard.write([new ClipboardItem({ 'image/png': blob })])
      return 'copied'
    } catch {
      // Permission denied or unsupported type — fall through to the download.
    }
  }

  try {
    const url = URL.createObjectURL(blob)
    const link = document.createElement('a')
    link.href = url
    link.download = filename
    link.click()
    setTimeout(() => URL.revokeObjectURL(url), 10_000)
    return 'downloaded'
  } catch {
    return 'failed'
  }
}
