// Waits for the PR-head TypeScript producer check on the PR head SHA and exits
// non-zero if it does not succeed. Run by reusable-await-ts-checks.yml from a
// trusted base-branch checkout. Reads check-run status only; never runs PR code.
//
// Env: GH_TOKEN, REPO, PR_HEAD_SHA, CHECK_NAME
import { execFileSync } from 'node:child_process'
import { setTimeout as sleep } from 'node:timers/promises'
import { pollForCheck } from './lib.mjs'

const POLL_INTERVAL_MS = 15_000
const TIMEOUT_MS = 25 * 60 * 1000

function fetchChecks(repo, sha) {
  // --paginate --jq '.check_runs[]' emits one check-run object per line across
  // all pages; filtering by name happens in lib so the check_name (which
  // contains a space and a slash) needs no URL encoding.
  const out = execFileSync(
    'gh',
    ['api', `repos/${repo}/commits/${sha}/check-runs`, '--paginate', '--jq', '.check_runs[]'],
    { encoding: 'utf8', maxBuffer: 128 * 1024 * 1024 },
  ).trim()
  if (!out) return []
  return out.split('\n').filter(Boolean).map((line) => JSON.parse(line))
}

async function main() {
  const repo = process.env.REPO ?? ''
  const sha = process.env.PR_HEAD_SHA ?? ''
  const checkName = process.env.CHECK_NAME ?? ''

  if (!repo || !sha || !checkName) {
    console.log('::error::REPO, PR_HEAD_SHA and CHECK_NAME are required')
    process.exit(1)
  }

  const code = await pollForCheck({
    checkName,
    fetchChecks: () => fetchChecks(repo, sha),
    now: () => Date.now(),
    sleep,
    pollIntervalMs: POLL_INTERVAL_MS,
    timeoutMs: TIMEOUT_MS,
    log: (msg) => console.log(msg),
  })
  process.exit(code)
}

main()
