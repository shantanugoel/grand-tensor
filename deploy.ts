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
if (preview) await $`wrangler versions upload --define BUILD_SHA:${JSON.stringify(id)}`
else await $`wrangler deploy --define BUILD_SHA:${JSON.stringify(id)}`

console.log(`\n${preview ? 'Uploaded preview of' : 'Deployed'} Grand Tensor ${id}`)
