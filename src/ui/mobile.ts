/** Small-screen affordances: the log ticker, and getting phones into landscape. */

const $ = <T extends HTMLElement = HTMLElement>(sel: string) => document.querySelector(sel) as T

/** Touch-first device. Used for affordances, never to gate functionality. */
export const isTouch = () => matchMedia('(pointer: coarse)').matches

/** Phones and short landscape windows share the collapsed layout. */
export const isCompact = () => matchMedia('(max-width: 860px), (max-height: 560px)').matches

/** Drops the rotate nudge — once a match is running it is just in the way. */
export function dismissRotateHint() {
  document.querySelector('.rotate-hint')?.remove()
}

/** Fullscreen + landscape where the platform allows it. iOS Safari allows
 *  neither, which is why the hint also just asks the user to rotate. */
async function goLandscape() {
  try {
    if (!document.fullscreenElement) await document.documentElement.requestFullscreen?.()
    await (screen.orientation as ScreenOrientation & { lock?: (o: string) => Promise<void> }).lock?.('landscape')
  } catch {
    // Unsupported or refused — the board still works, just taller than wide.
  }
}

export function setupMobile() {
  // The dock wraps to two rows on narrow screens; publish its height so the
  // ticker and verdict card can sit above it instead of guessing.
  const dock = $('.dock')
  const publishDockHeight = () =>
    document.documentElement.style.setProperty('--dock-h', `${Math.round(dock.offsetHeight)}px`)
  new ResizeObserver(publishDockHeight).observe(dock)
  publishDockHeight()

  const panel = $('#log-panel')
  $('#log-toggle').addEventListener('click', () => {
    panel.classList.toggle('expanded')
    const log = $('#log')
    log.scrollTop = log.scrollHeight
  })

  if (!isTouch()) return

  const fullscreen = $('#btn-fullscreen')
  fullscreen.classList.remove('hidden')
  fullscreen.addEventListener('click', goLandscape)

  const hint = document.createElement('button')
  hint.className = 'rotate-hint hidden'
  hint.innerHTML = '<span>⟳</span><span>Rotate for the full arena</span>'
  hint.addEventListener('click', () => {
    void goLandscape()
    hint.classList.add('hidden')
  })
  document.body.appendChild(hint)

  let dismissed = false
  const sync = () => hint.classList.toggle('hidden', dismissed || innerHeight <= innerWidth)
  // One nudge per visit: once they've seen landscape, stop asking.
  addEventListener('orientationchange', () => setTimeout(sync, 200))
  addEventListener('resize', () => {
    if (innerWidth > innerHeight) dismissed = true
    sync()
  })
  sync()
}
