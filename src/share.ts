/** Turning a finished series into something worth posting, and back again.
 *
 *  A shared link carries only the matchup — models, efforts, series length —
 *  never the API key, so opening one prompts you for your own. */

import type { Series } from './series'
import type { Effort, Settings } from './settings'

/** Efforts are provider-defined, so a shared link is only sanity-checked here;
 *  the series re-checks it against the model before the first request. */
const looksLikeEffort = (v: string) => /^[a-z]{2,10}$/.test(v)

/** Rebuildable matchup as a readable `#a=…&b=…` fragment. */
export function matchHash(s: Settings): string {
  const p = new URLSearchParams({
    an: s.players[0].label,
    a: s.players[0].model,
    ae: s.players[0].effort,
    bn: s.players[1].label,
    b: s.players[1].model,
    be: s.players[1].effort,
    g: String(s.games),
  })
  return `#${p}`
}

export function shareUrl(s: Settings): string {
  return `${location.origin}${location.pathname}${matchHash(s)}`
}

/** Applies a shared matchup to settings. Returns true if anything was read. */
export function applyMatchHash(s: Settings): boolean {
  const raw = location.hash.replace(/^#/, '')
  if (!raw) return false
  const p = new URLSearchParams(raw)
  if (!p.get('a') && !p.get('b')) return false

  const effort = (v: string | null, fallback: Effort): Effort => (v && looksLikeEffort(v) ? v : fallback)

  ;[0, 1].forEach((i) => {
    const key = i === 0 ? 'a' : 'b'
    const model = p.get(key)
    if (model) s.players[i].model = model
    s.players[i].label = p.get(`${key}n`) || model || s.players[i].label
    s.players[i].effort = effort(p.get(`${key}e`), s.players[i].effort)
  })

  const games = Number(p.get('g'))
  if (Number.isFinite(games) && games >= 1 && games <= 50) s.games = games
  return true
}

export const fmtScore = (n: number) => (Number.isInteger(n) ? String(n) : `${Math.floor(n)}½`)

const fmtTokens = (n: number) =>
  n >= 1_000_000 ? `${(n / 1_000_000).toFixed(1)}M` : n >= 1000 ? `${Math.round(n / 1000)}k` : String(n)

/** Wordle-style summary: one square per game, coloured by who took it. */
export function resultText(series: Series, s: Settings): string {
  const [a, b] = series.stats
  const squares = series.games
    .map((rec) => {
      if (rec.result === '1/2-1/2') return '⬜'
      const winner = rec.result === '1-0' ? rec.white : 1 - rec.white
      return winner === 0 ? '🟦' : '🟪'
    })
    .join('')

  const leader = series.leader
  const verdict =
    leader === null
      ? `Dead heat after ${series.games.length}.`
      : `${s.players[leader].label} takes the crown.`

  const moves = a.moves + b.moves
  const tokens = a.usage.total + b.usage.total
  const cost = a.usage.cost + b.usage.cost

  return [
    `♟ Grand Tensor — best of ${s.games}`,
    ``,
    `🟦 ${s.players[0].label}  ${fmtScore(a.score)}–${fmtScore(b.score)}  ${s.players[1].label} 🟪`,
    squares,
    ``,
    verdict,
    `${moves} moves · ${fmtTokens(tokens)} tokens${cost > 0 ? ` · $${cost.toFixed(cost < 0.01 ? 4 : 2)}` : ''}`,
    `Illegal moves: ${a.illegal} vs ${b.illegal}`,
    ``,
    shareUrl(s),
  ].join('\n')
}

export async function copyText(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text)
    return true
  } catch {
    // Clipboard API needs a secure context; fall back to a throwaway textarea.
    const el = document.createElement('textarea')
    el.value = text
    el.style.position = 'fixed'
    el.style.opacity = '0'
    document.body.appendChild(el)
    el.select()
    const ok = document.execCommand('copy')
    el.remove()
    return ok
  }
}

export function tweetUrl(text: string): string {
  return `https://twitter.com/intent/tweet?text=${encodeURIComponent(text)}`
}

export const canNativeShare = () => typeof navigator.share === 'function'

/** Whether the platform's share sheet will carry the result card itself. Level-2
 *  Web Share, so in practice: mobile Safari and Android Chrome, yes; desktop
 *  browsers, no. This is the only route that gets an image into an X post
 *  without an OAuth media upload — the user picks X in the sheet. */
export function canShareFile(file: File): boolean {
  return canNativeShare() && typeof navigator.canShare === 'function' && navigator.canShare({ files: [file] })
}

export async function nativeShare(text: string, url: string, file?: File | null) {
  // Platforms are inconsistent about honouring `url` alongside `files` — some
  // drop one or the other. `text` already ends with the link, so send just that.
  const payload: ShareData = file && canShareFile(file) ? { title: 'Grand Tensor', text, files: [file] } : { title: 'Grand Tensor', text, url }
  try {
    await navigator.share(payload)
  } catch {
    // The user dismissed the sheet — nothing to do.
  }
}
