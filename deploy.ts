/** Deploys the full-stack Worker with the commit it was built from baked in,
 *  so `/version` and the site's build meta tag identify the same source.
 *
 *  A script rather than a flag on the raw `wrangler deploy` because Wrangler's
 *  --define takes a JS literal, so the id has to arrive already quoted. */

import { $ } from 'bun'
import { buildId } from './build-id'

const id = await buildId()
const preview = Bun.argv.includes('--preview')

await $`tsc -p worker/tsconfig.json`

if (preview) {
  // A versions upload takes no traffic, so migrating for it would move the
  // production schema ahead of the code that is actually serving requests.
  await $`wrangler versions upload --define BUILD_SHA:${JSON.stringify(id)}`
} else {
  // Migrations first, and in the same command as the deploy, because
  // `wrangler deploy` does not apply them and the two must not drift: the
  // Worker deploys from a GitHub push through Cloudflare's own builder, where
  // nobody is at a terminal to remember this step. Wrangler tracks what it has
  // already applied, so this is a no-op on a deploy that adds no migration —
  // and if it cannot reach D1 at all, `$` throws and the deploy never happens,
  // which is the right way round: an unmigrated schema keeps serving the old
  // Worker instead of meeting a new one that expects columns it lacks.
  //
  // Run through the package script so the database name lives in one place.
  await $`bun run leaderboard:migrate:remote`
  await $`wrangler deploy --define BUILD_SHA:${JSON.stringify(id)}`
}

console.log(`\n${preview ? 'Uploaded preview of' : 'Deployed'} Grand Tensor ${id}`)
