/** Dev server. Bun bundles the HTML entrypoint and its imports on the fly and
 *  pushes hot updates; `bun run build` produces the same bundle statically. */

import index from './index.html'
import { ENGINE_ASSETS, ENGINE_DIR, ENGINE_SOURCE } from './src/engine-assets'

const port = Number(Bun.env.PORT ?? 5177)

const server = Bun.serve({
  port,
  routes: {
    // Served straight out of node_modules rather than copied into the repo: it
    // is 7 MB of wasm, and `bun run build` is where it becomes a real file. The
    // name is matched against a fixed list, so the path cannot be walked out of.
    [`${ENGINE_DIR}/:file`]: (req) =>
      ENGINE_ASSETS.includes(req.params.file)
        ? new Response(Bun.file(`${ENGINE_SOURCE}/${req.params.file}`))
        : new Response('Not found', { status: 404 }),
    // Everything falls through to the app so a deep link or a refresh still works.
    '/*': index,
  },
  development: { hmr: true, console: true },
})

console.log(`Grand Tensor dev server → ${server.url}`)
