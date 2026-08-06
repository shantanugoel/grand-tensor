/** Deploys the leaderboard Worker with the commit it was built from baked in,
 *  so `curl <worker>/version` answers the same question the site's build meta
 *  tag does. The Worker deploys by hand — no CI covers it — which is exactly
 *  why it needs to be able to say what it is running.
 *
 *  A script rather than a flag on the raw `wrangler deploy` because Wrangler's
 *  --define takes a JS literal, so the id has to arrive already quoted. */

import { $ } from 'bun'
import { buildId } from './build-id'

const id = await buildId()

await $`tsc -p worker/tsconfig.json`
await $`wrangler deploy --define BUILD_SHA:${JSON.stringify(id)}`

console.log(`\nDeployed Worker ${id}`)
