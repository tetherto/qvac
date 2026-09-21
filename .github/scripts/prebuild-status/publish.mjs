// Posts the qvac/prebuild-<pkg> commit status consumed by Merge Guard's
// verify-prebuilds. Run by on-pr-<pkg>.yml `publish-prebuild-status`.
//
// Env:
//   GH_TOKEN, REPO, HEAD_SHA, CONTEXT, RUN_URL, PREBUILD_RESULT, REUSE_HIT,
//   CI_ROUTER_RESULT, RUN_PREBUILDS
import { execFileSync } from 'node:child_process'
import { resolvePublishState } from './lib.mjs'

function main() {
  const repo = process.env.REPO ?? ''
  const sha = process.env.HEAD_SHA ?? ''
  const context = process.env.CONTEXT ?? ''
  const runUrl = process.env.RUN_URL ?? ''

  if (!sha) {
    console.log('No PR head SHA in context; nothing to publish.')
    return 0
  }
  if (!context) {
    console.log('::error title=Missing context::CONTEXT env is required to publish a prebuild status.')
    return 1
  }

  const state = resolvePublishState(
    process.env.PREBUILD_RESULT,
    process.env.REUSE_HIT,
    process.env.CI_ROUTER_RESULT,
    process.env.RUN_PREBUILDS,
  )

  execFileSync(
    'gh',
    [
      'api',
      '-X',
      'POST',
      `repos/${repo}/statuses/${sha}`,
      '-f',
      `state=${state}`,
      '-f',
      `context=${context}`,
      '-f',
      `target_url=${runUrl}`,
      '-f',
      `description=prebuild ${state}`,
    ],
    { stdio: ['ignore', 'ignore', 'inherit'] },
  )
  console.log(`Posted ${context} = ${state} (${runUrl}) on ${sha}`)
  return 0
}

process.exit(main())
