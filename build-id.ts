/** The commit identifier both deployables stamp themselves with, so the site
 *  and the Worker can be correlated against the same repo and against each
 *  other. Shared by `build.ts` and `deploy-worker.ts`. */

import { $ } from 'bun'

/** CI hands the SHA over in the environment; locally we ask git. A dirty tree
 *  is marked, so a hand-built or hand-deployed artifact is never read as the
 *  commit it was built from. */
export async function buildId() {
  const fromCi = Bun.env.GITHUB_SHA
  if (fromCi) return fromCi.slice(0, 7)

  const head = await $`git rev-parse --short=7 HEAD`.nothrow().quiet()
  if (head.exitCode !== 0) return 'unknown'
  const dirty = (await $`git status --porcelain`.nothrow().quiet()).text().trim()
  return head.text().trim() + (dirty ? '-dirty' : '')
}
