/** The commit identifier stamped into both halves of the full-stack deploy.
 *  Shared by `build.ts` and `deploy.ts`. */

import { $ } from 'bun'

/** CI hands the SHA over in the environment; locally we ask git. A dirty tree
 *  is marked, so a hand-built or hand-deployed artifact is never read as the
 *  commit it was built from. */
export async function buildId() {
  const fromCi = Bun.env.WORKERS_CI_COMMIT_SHA ?? Bun.env.GITHUB_SHA
  if (fromCi) return fromCi.slice(0, 7)

  const head = await $`git rev-parse --short=7 HEAD`.nothrow().quiet()
  if (head.exitCode !== 0) return 'unknown'
  const dirty = (await $`git status --porcelain`.nothrow().quiet()).text().trim()
  return head.text().trim() + (dirty ? '-dirty' : '')
}
