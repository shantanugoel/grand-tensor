/** Serves the built `dist/` exactly as a static host would, for a last look
 *  before deploying. Run `bun run build` first. */

const root = new URL('./dist/', import.meta.url)
const port = Number(Bun.env.PORT ?? 5178)

const server = Bun.serve({
  port,
  async fetch(req) {
    const path = new URL(req.url).pathname
    const file = Bun.file(new URL(`.${path}`, root))
    if (await file.exists()) return new Response(file)
    // Unknown paths fall back to the app, same as a static host's SPA rule.
    return new Response(Bun.file(new URL('./index.html', root)))
  },
})

console.log(`Grand Tensor preview → ${server.url}`)
