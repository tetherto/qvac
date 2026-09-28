// Posts the qvac/prebuild-<pkg> or qvac/cpp-tests-<pkg> commit status consumed
// by Merge Guard's verify-prebuilds / verify-cpp-tests. Run by the on-pr
// orchestrators' `publish-prebuild-status` / `publish-cpp-test-status` jobs.
//
// Env:
//   GH_TOKEN, REPO, HEAD_SHA, CONTEXT, RUN_URL, REUSE_HIT, CI_ROUTER_RESULT,
//   KIND ('prebuild' when unset, or 'cpp-tests'), plus the kind's own pair:
//     prebuild:  PREBUILD_RESULT, RUN_PREBUILDS
//     cpp-tests: CPP_TEST_RESULT, RUN_CPP_TESTS
import { execFileSync } from 'node:child_process'
import { resolvePublishState } from './lib.mjs'

const KINDS = {
  prebuild: { resultEnv: 'PREBUILD_RESULT', runFlagEnv: 'RUN_PREBUILDS' },
  'cpp-tests': { resultEnv: 'CPP_TEST_RESULT', runFlagEnv: 'RUN_CPP_TESTS' },
}

function main() {
  const kindName = process.env.KIND || 'prebuild'
  const kind = KINDS[kindName]
  const repo = process.env.REPO ?? ''
  const sha = process.env.HEAD_SHA ?? ''
  const context = process.env.CONTEXT ?? ''
  const runUrl = process.env.RUN_URL ?? ''

  if (!kind) {
    console.log(`::error title=Unknown KIND::KIND=${JSON.stringify(kindName)} is not one of ${Object.keys(KINDS).join(', ')}.`)
    return 1
  }
  if (!sha) {
    console.log('No PR head SHA in context; nothing to publish.')
    return 0
  }
  if (!context) {
    console.log(`::error title=Missing context::CONTEXT env is required to publish a ${kindName} status.`)
    return 1
  }

  const state = resolvePublishState(
    process.env[kind.resultEnv],
    process.env.REUSE_HIT,
    process.env.CI_ROUTER_RESULT,
    process.env[kind.runFlagEnv],
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
      `description=${kindName} ${state}`,
    ],
    { stdio: ['ignore', 'ignore', 'inherit'] },
  )
  console.log(`Posted ${context} = ${state} (${runUrl}) on ${sha}`)
  return 0
}

process.exit(main())
