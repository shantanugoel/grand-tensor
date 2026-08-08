/** Production build: type-checks the client, bundles it into a clean dist/, and
 *  stamps the commit it was built from into dist/index.html.
 *
 *  The stamp is the point. Asset filenames are content hashes, so two deploys
 *  of different commits are indistinguishable on the wire whenever the diff
 *  between them missed the client bundle — which every test-only and
 *  Worker-only commit does. The stamp changes every commit regardless. */

import { $ } from 'bun'
import { buildId } from './build-id'
import { ENGINE_ASSETS, ENGINE_DIR, ENGINE_SOURCE } from './src/engine-assets'

/** The placeholder index.html ships with, and that the dev server keeps. */
const PLACEHOLDER = '<meta name="build" content="dev" />'

const id = await buildId()

await $`tsc --noEmit`
await $`rm -rf dist`

const result = await Bun.build({
  entrypoints: ['./index.html'],
  outdir: 'dist',
  minify: true,
  // Assets resolve relative to the page, so the site works from any path.
  publicPath: './',
  // The API's own defaults would emit these as `chunk-<hash>`; this is the
  // scheme the `bun build` CLI used before this script replaced it.
  // index.html has to keep its name to stay the entry point a host serves;
  // everything it pulls in is content-hashed for caching.
  naming: { entry: '[dir]/[name].[ext]', chunk: '[name]-[hash].[ext]', asset: '[name]-[hash].[ext]' },
})

if (!result.success) {
  for (const log of result.logs) console.error(log)
  process.exit(1)
}

for (const output of result.outputs)
  console.log(`  ${output.path.split('/').pop()}  ${(output.size / 1024).toFixed(1)} KB`)

// The engine is copied rather than bundled: it is a wasm blob and its own
// emscripten glue, which loads the .wasm by deriving the URL from its own
// script — a hashed name from the bundler would break that pairing. Nothing
// imports it, so nothing fetches it until the commentary asks for it.
// Stockfish is GPLv3 and this ships a copy of it, so its licence ships beside
// it. Nothing links against it — it is a separate binary in its own Worker —
// but conveying the program means conveying the terms.
await Bun.write(`dist${ENGINE_DIR}/LICENSE.txt`, Bun.file(`${ENGINE_SOURCE}/../Copying.txt`))

for (const name of ENGINE_ASSETS) {
  const from = Bun.file(`${ENGINE_SOURCE}/${name}`)
  if (!(await from.exists())) throw new Error(`Missing engine asset ${name} — run \`bun install\``)
  await Bun.write(`dist${ENGINE_DIR}/${name}`, from)
  console.log(`  ${name}  ${(from.size / 1024).toFixed(1)} KB`)
}

const html = await Bun.file('dist/index.html').text()
// A silent miss here would ship an unstamped build that still looks fine, so
// this fails the build instead.
if (!html.includes(PLACEHOLDER)) throw new Error(`No build stamp placeholder (${PLACEHOLDER}) in dist/index.html`)
await Bun.write('dist/index.html', html.replace(PLACEHOLDER, `<meta name="build" content="${id}" />`))

// Workers Static Assets applies these at the edge. HTML must revalidate so a
// deployment becomes visible immediately; content-hashed assets can live in a
// browser cache forever.
await Bun.write(
  'dist/_headers',
  `/*
  X-Content-Type-Options: nosniff
  Referrer-Policy: no-referrer
  X-Frame-Options: DENY
  Permissions-Policy: camera=(), microphone=(), geolocation=()

/
  Cache-Control: no-cache

/index.html
  Cache-Control: no-cache

/*.js
  Cache-Control: public, max-age=31536000, immutable

/*.css
  Cache-Control: public, max-age=31536000, immutable

/engine/*
  Cache-Control: public, max-age=31536000, immutable
`,
)

console.log(`\nBuild ${id} → dist/`)
