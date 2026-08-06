/** Dev server. Bun bundles the HTML entrypoint and its imports on the fly and
 *  pushes hot updates; `bun run build` produces the same bundle statically. */

import index from './index.html'

const port = Number(Bun.env.PORT ?? 5177)

const server = Bun.serve({
  port,
  // Everything falls through to the app so a deep link or a refresh still works.
  routes: { '/*': index },
  development: { hmr: true, console: true },
})

console.log(`Grand Tensor dev server → ${server.url}`)
