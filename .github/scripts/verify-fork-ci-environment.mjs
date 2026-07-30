#!/usr/bin/env node
/**
 * Verify the fork-ci GitHub Environment is configured with required reviewers.
 * Run locally or in CI with gh authenticated (repo admin or environments read).
 *
 * Usage: node .github/scripts/verify-fork-ci-environment.mjs
 * Exit 0 when protection looks correct; non-zero with actionable errors otherwise.
 */
import { spawnSync } from 'node:child_process'

function ghApi(path) {
  const result = spawnSync(
    'gh',
    ['api', path, '--jq', '.'],
    { encoding: 'utf8' },
  )
  if (result.status !== 0) {
    throw new Error(
      `gh api ${path} failed: ${result.stderr || result.stdout || 'unknown error'}`,
    )
  }
  return JSON.parse(result.stdout || '{}')
}

function main() {
  const repo = process.env.GITHUB_REPOSITORY || 'tetherto/qvac'
  const env = ghApi(`repos/${repo}/environments/fork-ci`)

  const errors = []

  if (!env || !env.id) {
    errors.push(`Environment fork-ci not found on ${repo}`)
  } else {
    const reviewers = env.protection_rules?.find((r) => r.type === 'required_reviewers')
    const count = reviewers?.reviewers?.length ?? 0
    if (count < 1) {
      errors.push(
        'fork-ci has no required_reviewers protection rule — external fork jobs can auto-run without human approval',
      )
    }

    if (env.wait_timer && env.wait_timer > 0) {
      console.log(`note: fork-ci wait_timer=${env.wait_timer} minutes`)
    }

    console.log(
      `fork-ci OK: ${count} required reviewer group(s) on ${repo} (id=${env.id})`,
    )
  }

  if (errors.length) {
    for (const err of errors) {
      console.error(`ERROR: ${err}`)
    }
    console.error(
      'Configure fork-ci in GitHub → Settings → Environments → fork-ci → Required reviewers (merge/release teams).',
    )
    process.exit(1)
  }
}

try {
  main()
} catch (e) {
  console.error(`verify-fork-ci-environment: ${e.message}`)
  console.error(
    'Re-run with gh authenticated (gh auth status) or set GITHUB_REPOSITORY for fork repos.',
  )
  process.exit(2)
}
