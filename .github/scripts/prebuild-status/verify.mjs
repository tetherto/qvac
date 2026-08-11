// Verifies addon prebuilds for Merge Guard WITHOUT triggering them. Run by
// pr-gate-merge.yml `verify-prebuilds`. Reads each qvac/prebuild-<pkg> commit
// status on the PR head SHA, binds it to the on-pr-<pkg> run that produced it
// (via the status target_url), and trusts it only when that run was triggered
// at/after this PR event. Waits (fail-closed) until every required prebuild has
// a fresh terminal status or the timeout elapses.
//
// Env: GH_TOKEN, REPO, HEAD_SHA, CHANGED_PACKAGES, PR_UPDATED_AT
import { execFileSync } from 'node:child_process'
import { setTimeout as sleep } from 'node:timers/promises'
import { expectedPrebuilds, flattenPages, evaluatePackage } from './lib.mjs'

const POLL_INTERVAL_MS = 30_000
const TIMEOUT_MS = 180 * 60 * 1000

function ghJson(args) {
  const out = execFileSync('gh', ['api', ...args], {
    encoding: 'utf8',
    maxBuffer: 128 * 1024 * 1024,
  }).trim()
  return out ? JSON.parse(out) : null
}

function fetchStatuses(repo, sha) {
  // --slurp collects every page into a single JSON value; flattenPages merges
  // the per-page arrays so a context spanning pages is considered together.
  const raw = ghJson([`repos/${repo}/commits/${sha}/statuses`, '--paginate', '--slurp'])
  return flattenPages(raw ?? [])
}

function fetchRun(repo, runId) {
  try {
    return ghJson([`repos/${repo}/actions/runs/${runId}`])
  } catch {
    return null
  }
}

async function main() {
  const repo = process.env.REPO ?? ''
  const sha = process.env.HEAD_SHA ?? ''
  const prUpdatedAt = process.env.PR_UPDATED_AT ?? ''
  let changed = []
  try {
    changed = JSON.parse(process.env.CHANGED_PACKAGES || '[]')
  } catch {
    changed = []
  }

  const expected = expectedPrebuilds(changed)
  console.log(`Head SHA:            ${sha}`)
  console.log(`Changed packages:    ${JSON.stringify(changed)}`)
  console.log(`Prebuilds to check:  ${JSON.stringify(expected)}`)
  console.log(`Freshness threshold: ${prUpdatedAt}`)

  if (expected.length === 0) {
    console.log('No prebuild-bearing package changed - build not applicable, passing.')
    return 0
  }

  // Fail closed if we cannot establish the freshness threshold: without it a
  // stale status could be trusted, so refuse to verify rather than guess.
  const prUpdatedMs = Date.parse(prUpdatedAt)
  if (!prUpdatedAt || Number.isNaN(prUpdatedMs)) {
    console.log(
      `::error title=Missing PR timestamp::pull_request.updated_at is missing or unparseable (${JSON.stringify(prUpdatedAt)}); cannot correlate prebuild status freshness.`,
    )
    return 1
  }
  const prUpdatedEpoch = Math.floor(prUpdatedMs / 1000)
  const deadline = Date.now() + TIMEOUT_MS
  const lookupRun = (runId) => fetchRun(repo, runId)

  for (;;) {
    const statuses = fetchStatuses(repo, sha)
    const pending = []
    const failed = []
    for (const pkg of expected) {
      const outcome = evaluatePackage(statuses, pkg, prUpdatedEpoch, lookupRun)
      if (outcome === 'failed') failed.push(`qvac/prebuild-${pkg}`)
      else if (outcome === 'pending') pending.push(`qvac/prebuild-${pkg}`)
    }

    if (failed.length > 0) {
      console.log(`::error title=Prebuild has not returned success::Failing prebuild status(es): ${failed.join(' ')}`)
      return 1
    }
    if (pending.length === 0) {
      console.log('All required prebuild statuses succeeded (fresh vs this PR event).')
      return 0
    }
    if (Date.now() >= deadline) {
      console.log(`::error title=Prebuild verification timed out::No fresh terminal prebuild status after timeout for: ${pending.join(' ')}`)
      return 1
    }
    console.log(`Waiting on prebuild status(es): ${pending.join(' ')} - re-checking in 30s`)
    await sleep(POLL_INTERVAL_MS)
  }
}

main()
  .then((code) => process.exit(code))
  .catch((err) => {
    console.error(err)
    process.exit(1)
  })
