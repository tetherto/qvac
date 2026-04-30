import * as core from '@actions/core'
import { execSync } from 'child_process'

const ZERO_SHA = '0000000000000000000000000000000000000000'

try {
  const baseRef = core.getInput('base-ref', { required: true })
  const baseSha = core.getInput('base-sha', { required: false })
  const headSha = core.getInput('head-sha', { required: true })
  const pkgSlug = core.getInput('package-slug', { required: true })
  const pkgJsonPath = core.getInput('package-json-path', { required: true })
  const changelogPath = core.getInput('changelog-path', { required: true })

  const isInitialPush = !baseSha || baseSha === ZERO_SHA

  const errors: string[] = []

  // ── Branch name validation (always runs)
  const match = baseRef.match(/^release-(.+)-(\d+\.\d+\.\d+)$/)
  if (!match) {
    errors.push(
      `Invalid release branch name — expected: release-${pkgSlug}-x.y.z, actual: ${baseRef}`
    )
  }

  let branchVersion = ''

  if (match) {
    const branchPkg = match[1]
    branchVersion = match[2]

    if (branchPkg !== pkgSlug) {
      core.warning(
        `Package slug mismatch — branch targets '${branchPkg}', workflow expects '${pkgSlug}'. ` +
        `This is expected for short-name release branches (e.g. release-diffusion-x.y.z).`
      )
    }
  }

  // ── package.json version must match the branch version (always runs)
  const headPkg = JSON.parse(execSync(`git show ${headSha}:${pkgJsonPath}`).toString())

  if (branchVersion && headPkg.version !== branchVersion) {
    errors.push(
      `Version mismatch — branch version: ${branchVersion}, package.json: ${headPkg.version}`
    )
  }

  // ── Changelog must be modified in this push (skipped on initial branch creation)
  if (isInitialPush) {
    core.info('Initial branch push detected (no base SHA) — skipping changelog check')
  } else {
    const changedFiles = execSync(
      `git diff --name-only ${baseSha} ${headSha}`
    ).toString()

    if (!changedFiles.includes(changelogPath)) {
      errors.push(
        `Missing CHANGELOG update — file not modified: ${changelogPath}`
      )
    }
  }

  // ── Report results
  for (const err of errors) {
    core.error(err)
  }

  if (errors.length) {
    core.setFailed(`Release merge guard failed with ${errors.length} error(s):\n${errors.join('\n')}`)
  } else {
    core.info('Release merge guard passed — branch name, version, and changelog all valid')
  }
} catch (err) {
  core.setFailed(err instanceof Error ? err.message : String(err))
}
