// What the Python and Kotlin clients' PR checks share: whether a pull request changed a client's own folder, and the
// SDK prepared to export the contract the clients are generated from.

import { execFileSync } from 'node:child_process'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = fileURLToPath(new URL('../../..', import.meta.url))
const SDK = join(ROOT, 'packages/sdk')
const run = (cmd, args, cwd) => execFileSync(cmd, args, { cwd, stdio: 'inherit' })

// A pull request runs a client's own checks only when a file under its folder changed, diffing the commits the
// selection compared. A dispatch, a release train or a failed diff runs them.
export function ownChanged(dir, env = process.env) {
  const pr = ['pull_request', 'pull_request_target'].includes(env.GITHUB_EVENT_NAME)
  if (!pr || env.SOURCE !== 'self' || !env.BASE_SHA || !env.HEAD_SHA) return true
  try {
    const repo = `https://github.com/${env.GITHUB_REPOSITORY}.git`
    run('git', ['fetch', '--no-tags', '--filter=blob:none', repo, env.BASE_SHA, env.HEAD_SHA], ROOT)
    const files = execFileSync('git', ['diff', '--name-only', env.BASE_SHA, env.HEAD_SHA], {
      cwd: ROOT,
      encoding: 'utf8'
    }).split('\n')
    return files.some((file) => file.startsWith(`${dir}/`))
  } catch (e) {
    console.log(
      `::warning::could not diff the pull request, running the ${dir} checks: ${e.message}`
    )
    return true
  }
}

// In CI, where a client's checks start from a bare checkout, the SDK installed against the sibling packages/inference
// and that engine built, which exporting the contract needs. The link script rewrites the SDK manifest; node_modules
// keeps the link once it is restored. A local checkout already has the SDK installed.
export function prepareSdk(env = process.env) {
  if (!env.CI) return
  run('npm', ['run', 'sdk-source:workspace'], SDK)
  run('git', ['checkout', '--', 'package.json'], SDK)
}
