import * as core from '@actions/core'
import { execSync } from 'child_process'

function parseVersion(v: string): [number, number, number] {
  const m = v.match(/^(\d+)\.(\d+)\.(\d+)$/)
  if (!m) throw new Error(`Invalid semver: ${v}`)
  return [Number(m[1]), Number(m[2]), Number(m[3])]
}

function isGreater(a: string, b: string): boolean {
  const pa = parseVersion(a)
  const pb = parseVersion(b)
  for (let i = 0; i < 3; i++) {
    if (pa[i] > pb[i]) return true
    if (pa[i] < pb[i]) return false
  }
  return false
}

try {
  const baseRef = core.getInput('base-ref', { required: true })
  const baseSha = core.getInput('base-sha', { required: true })
  const headSha = core.getInput('head-sha', { required: true })
  const pkgSlug = core.getInput('package-slug', { required: true })
  const pkgJsonPath = core.getInput('package-json-path', { required: true })
  const changelogPath = core.getInput('changelog-path', { required: true })

  const errors: string[] = []

  // ── Branch name validation
  const match = baseRef.match(/^release-(.+)-(\d+\.\d+\.\d+)$/)
  if (!match) {
    errors.push(
      `Invalid release branch name — expected: release-${pkgSlug}-x.y.z, actual: ${baseRef}`
    )
  }

  let branchPkg = ''
  let branchVersion = ''

  if (match) {
    branchPkg = match[1]
    branchVersion = match[2]

    if (branchPkg !== pkgSlug) {
      errors.push(
        `Package mismatch — branch targets '${branchPkg}', workflow expects '${pkgSlug}'`
      )
    }
  }

  // ── Read versions
  const basePkg = JSON.parse(execSync(`git show ${baseSha}:${pkgJsonPath}`).toString())
  const headPkg = JSON.parse(execSync(`git show ${headSha}:${pkgJsonPath}`).toString())

  if (branchVersion && headPkg.version !== branchVersion) {
    errors.push(
      `Version mismatch — branch version: ${branchVersion}, package.json: ${headPkg.version}`
    )
  }

  if (!isGreater(headPkg.version, basePkg.version)) {
    errors.push(
      `Version not incremented — base: ${basePkg.version}, head: ${headPkg.version}`
    )
  }

  // ── Changelog must be modified
  const changedFiles = execSync(
    `git diff --name-only ${baseSha} ${headSha}`
  ).toString()

  if (!changedFiles.includes(changelogPath)) {
    errors.push(
      `Missing CHANGELOG update — file not modified: ${changelogPath}`
    )
  }

  // ── Report results
  for (const err of errors) {
    core.error(err)
  }

  if (errors.length) {
    core.setFailed(`Release merge guard failed with ${errors.length} error(s):\n${errors.join('\n')}`)
  }
} catch (err) {
  core.setFailed(err instanceof Error ? err.message : String(err))
}
