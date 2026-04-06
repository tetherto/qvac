import * as core from '@actions/core'
import * as github from '@actions/github'
import fs from 'fs'
import { execSync } from 'child_process'

function parseVersion(v: string): [number, number, number] {
  const m = v.match(/^(\d+)\.(\d+)\.(\d+)$/)
  if (!m) throw new Error(`Invalid semver: ${v}`)
  return [Number(m[1]), Number(m[2]), Number(m[3])]
}

function isGreater(a: string, b: string): boolean {
  const pa = parseVersion(a)
  const pb = parseVersion(b)
  return pa > pb
}

async function run() {
  const token = core.getInput('github-token', { required: true })
  const baseRef = core.getInput('base-ref', { required: true })
  const baseSha = core.getInput('base-sha', { required: true })
  const headSha = core.getInput('head-sha', { required: true })
  const pkgSlug = core.getInput('package-slug', { required: true })
  const pkgJsonPath = core.getInput('package-json-path', { required: true })
  const changelogPath = core.getInput('changelog-path', { required: true })

  const octokit = github.getOctokit(token)
  const { owner, repo } = github.context.repo
  const prNumber = github.context.payload.pull_request?.number

  const errors: string[] = []

  // ── Branch name validation
  const match = baseRef.match(/^release-(.+)-(\d+\.\d+\.\d+)$/)
  if (!match) {
    errors.push(
      `❌ **Invalid release branch name**\nExpected: \`release-${pkgSlug}-x.y.z\`\nActual: \`${baseRef}\``
    )
  }

  let branchPkg = ''
  let branchVersion = ''

  if (match) {
    branchPkg = match[1]
    branchVersion = match[2]

    if (branchPkg !== pkgSlug) {
      errors.push(
        `❌ **Package mismatch**\nBranch targets \`${branchPkg}\`, workflow expects \`${pkgSlug}\``
      )
    }
  }

  // ── Read versions
  const basePkg = JSON.parse(execSync(`git show ${baseSha}:${pkgJsonPath}`).toString())
  const headPkg = JSON.parse(execSync(`git show ${headSha}:${pkgJsonPath}`).toString())

  if (branchVersion && headPkg.version !== branchVersion) {
    errors.push(
      `❌ **Version mismatch**\nBranch version: \`${branchVersion}\`\npackage.json: \`${headPkg.version}\``
    )
  }

  if (!isGreater(headPkg.version, basePkg.version)) {
    errors.push(
      `❌ **Version not incremented**\nBase: \`${basePkg.version}\`\nPR: \`${headPkg.version}\``
    )
  }

  // ── Changelog must be modified
  const changedFiles = execSync(
    `git diff --name-only ${baseSha} ${headSha}`
  ).toString()

  if (!changedFiles.includes(changelogPath)) {
    errors.push(
      `❌ **Missing CHANGELOG update**\nFile not modified: \`${changelogPath}\``
    )
  }

  // ── Report results
  if (errors.length && prNumber) {
    await octokit.rest.issues.createComment({
      owner,
      repo,
      issue_number: prNumber,
      body: `### 🚫 Release PR validation failed\n\n${errors.join('\n\n')}`
    })
  }

  if (errors.length) {
    core.setFailed('Release PR validation failed')
  }
}

run().catch(err => core.setFailed(err.message))
