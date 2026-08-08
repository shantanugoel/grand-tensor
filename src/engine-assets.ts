/** Where the Stockfish wasm build lives, named once for the three places that
 *  have to agree: the dev server that serves it out of node_modules, the build
 *  that copies it into dist/, and the browser that loads it.
 *
 *  Single-threaded on purpose. The threaded builds need SharedArrayBuffer, which
 *  needs COOP/COEP `require-corp` on the document — and that would break both
 *  the Turnstile frame from challenges.cloudflare.com and the Google Fonts
 *  stylesheet. A slower engine is a far better trade than a broken leaderboard
 *  submission.
 *
 *  The lite build rather than the full one for the same kind of reason: 7 MB of
 *  wasm against 117 MB. It carries a smaller NNUE and gives up perhaps 100 Elo,
 *  which is nothing next to the gap between it and the models it is grading.
 *
 *  The version is in the filename, so the asset can be cached immutably and an
 *  upgrade is a new URL rather than a stale one. */

export const ENGINE_DIR = '/engine'

/** Relative to the repo root. */
export const ENGINE_SOURCE = 'node_modules/stockfish/bin'

/** The glue and the wasm it fetches alongside itself. Both names are load-bearing
 *  — the glue derives the .wasm URL from its own — so they travel together. */
export const ENGINE_GLUE = 'stockfish-18-lite-single.js'
export const ENGINE_WASM = 'stockfish-18-lite-single.wasm'
export const ENGINE_ASSETS = [ENGINE_GLUE, ENGINE_WASM]

export const ENGINE_URL = `${ENGINE_DIR}/${ENGINE_GLUE}`
