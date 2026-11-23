#!/usr/bin/env node
// Cuts release-<dir>-<x.y.z> for every addon a main commit bumps and starts publish-npm.yml there; the npm approval stays the gate.
// Scan mode (no commit) starts the release branches that were waiting for a @qvac dependency to reach npm.
import { spawnSync } from 'node:child_process'
import { appendFileSync } from 'node:fs'
import { pathToFileURL } from 'node:url'
import { compareVersions, parseNpmView } from './lib/release-train.mjs'

const VERSION = /^\d+\.\d+\.\d+$/
const DEP_FIELDS = ['dependencies', 'peerDependencies', 'optionalDependencies']
const BRANCH = /^release-(.+)-(\d+\.\d+\.\d+)$/
// A scan leaves a branch this young to the push run that cut it.
const FRESH_MINUTES = 15

const parse = (text) => {
  try {
    return text == null ? null : JSON.parse(text)
  } catch {
    return null
  }
}

const isAddon = (manifest, project) =>
  Boolean(manifest?.name && !manifest.private && project?.tags?.includes('ci:addons') && project.targets?.publish)

export function versionBumps({ changed, readBase, readHead }) {
  const dirs = new Set()
  for (const path of changed) {
    const m = /^packages\/([^/]+)\/package\.json$/.exec(path)
    if (m) dirs.add(m[1])
  }
  const bumps = []
  for (const dir of [...dirs].sort()) {
    const head = parse(readHead(`packages/${dir}/package.json`))
    if (!isAddon(head, parse(readHead(`packages/${dir}/project.json`)))) continue
    const from = parse(readBase(`packages/${dir}/package.json`))?.version ?? null
    if (from === head.version) continue
    bumps.push({ dir, name: head.name, from, version: head.version, manifest: head })
  }
  return bumps
}

// Release branches for addons whose version on main is still the branch's version: the ones a scan may start.
export function pendingBranches({ heads, readMain }) {
  const pending = []
  for (const { branch, sha } of heads) {
    const m = BRANCH.exec(branch)
    if (!m || branch.startsWith('release-train-')) continue
    const [, dir, version] = m
    const main = parse(readMain(`packages/${dir}/package.json`))
    if (main?.version !== version || !isAddon(main, parse(readMain(`packages/${dir}/project.json`)))) continue
    pending.push({ dir, version, sha })
  }
  return pending.sort((a, b) => a.dir.localeCompare(b.dir))
}

const PLATFORMS = ['linux', 'darwin', 'win32', 'android', 'ios']
const isOwnPlatformPackage = (own, name) =>
  name.startsWith(`${own}-`) && PLATFORMS.includes(name.slice(own.length + 1).split('-')[0])

// The package's own platform packages publish in the same run, so they are not prerequisites.
export function qvacRanges(manifest) {
  const ranges = []
  for (const field of DEP_FIELDS) {
    for (const [name, range] of Object.entries(manifest[field] ?? {})) {
      if (isOwnPlatformPackage(manifest.name, name)) continue
      if (name.startsWith('@qvac/') && /^[~^]?\d+\.\d+\.\d+$/.test(range)) ranges.push({ name, range })
    }
  }
  return ranges
}

function decide(bump, { sha, mainVersion, isPublished, rangeAvailable, branchSha, publishRun, onMain, minutesOld }) {
  const target = bump.sha ?? sha
  if (!VERSION.test(bump.version)) return { action: 'skip', reason: `${bump.version} is not x.y.z` }
  if (bump.from && VERSION.test(bump.from) && compareVersions(bump.version, bump.from) < 0)
    return { action: 'skip', reason: `version went down from ${bump.from}` }
  if (isPublished(bump.name, bump.version)) return { action: 'skip', reason: 'already on npm' }
  if (bump.sha && !onMain(bump.sha)) return { action: 'skip', reason: 'branch commit is not on main' }
  const current = mainVersion(bump.dir)
  if (current && VERSION.test(current) && compareVersions(current, bump.version) > 0)
    return { action: 'skip', reason: `main has moved on to ${current}` }
  const branch = `release-${bump.dir}-${bump.version}`
  const existing = branchSha(branch)
  if (existing && existing !== target)
    return { action: 'skip', reason: `${branch} already exists at ${existing.slice(0, 9)}` }
  if (bump.sha && minutesOld(bump.sha) < FRESH_MINUTES)
    return { action: 'skip', reason: 'merged moments ago; its own run handles it' }
  const run = existing ? publishRun(branch, existing) : null
  if (run)
    return {
      action: 'skip',
      reason: `publish run already exists (${run.conclusion || run.status}): ${run.url}`,
    }
  const missing = qvacRanges(bump.manifest).filter(({ name, range }) => !rangeAvailable(name, range))
  if (missing.length)
    return {
      action: 'wait',
      exists: Boolean(existing),
      reason: `needs ${missing.map(({ name, range }) => `${name}@${range}`).join(', ')} on npm first`,
    }
  return { action: existing ? 'dispatch' : 'release' }
}

// Every lookup is injected so the decision table is testable without npm or GitHub; one failed lookup fails only its row.
export function plan(bumps, lookups) {
  return bumps.map((bump) => {
    const row = {
      dir: bump.dir,
      name: bump.name,
      version: bump.version,
      sha: bump.sha ?? lookups.sha,
      branch: `release-${bump.dir}-${bump.version}`,
    }
    try {
      return { ...row, ...decide(bump, lookups) }
    } catch (error) {
      return { ...row, action: 'failed', reason: error.message.split('\n')[0] }
    }
  })
}

const LABELS = {
  release: ['branch cut, publish started, waiting for npm approval', 'would cut the branch and start publish'],
  dispatch: ['publish started, waiting for npm approval', 'would start publish on the existing branch'],
  wait: ['branch cut, publish starts once the dependency is on npm', 'would cut the branch and wait for the dependency'],
  skip: ['skipped', 'skipped'],
  failed: ['not started', 'not started'],
}

// Runs the writes each planned row needs; a failed write marks only its row failed.
export function apply(rows, { dryRun, create, start }) {
  for (const row of rows) {
    const needsBranch = row.action === 'release' || (row.action === 'wait' && !row.exists)
    const needsRun = row.action === 'release' || row.action === 'dispatch'
    if (dryRun || !(needsBranch || needsRun)) continue
    try {
      if (needsBranch) create(row)
      if (needsRun && start(row) === false) {
        row.action = 'skip'
        row.reason = 'another auto-release run started its publish first'
      }
    } catch (error) {
      row.action = 'failed'
      row.reason = error.message.split('\n')[0]
    }
  }
  return rows
}

// Only a real publish of this exact commit counts: not a dry run, not an older branch of the same name.
export const releaseRun = (runs, head) =>
  runs.find((r) => r.headSha === head && !r.displayTitle?.includes('(dry run)')) ?? null

// A scan reports what it starts, what waits or fails, and a publish that needs a re-run.
export const scanReports = (row) =>
  row.action !== 'skip' || /^publish run already exists \((failure|cancelled)/.test(row.reason)

export const diffBase = (sha, before) => (before && !/^0+$/.test(before) ? before : `${sha}^1`)

export function summary(rows, { title, dryRun }) {
  const lines = [`## ${title}${dryRun ? ' (dry run)' : ''}`, '']
  if (!rows.length) return [...lines, 'Nothing to release.'].join('\n')
  lines.push('| Package | Version | Result |', '|---|---|---|')
  for (const r of rows) {
    let label = LABELS[r.action][dryRun ? 1 : 0]
    if (r.action === 'wait' && r.exists && !dryRun) label = 'publish starts once the dependency is on npm'
    lines.push(`| ${r.name} | ${r.version} | ${label}${r.reason ? `: ${r.reason}` : ''} |`)
  }
  if (rows.some((r) => r.action === 'wait'))
    lines.push('', 'Waiting releases start on their own within an hour of the dependency publishing.')
  if (rows.some((r) => r.action === 'skip' && /publish run already exists \((failure|cancelled)/.test(r.reason)))
    lines.push('', 'A failed or cancelled publish is not restarted here; re-run it from its run page.')
  return lines.join('\n')
}

function run(command, args) {
  return spawnSync(command, args, { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 })
}

function capture(command, args) {
  const r = run(command, args)
  if (r.status !== 0) throw new Error(`${command} ${args.join(' ')} failed (exit ${r.status}): ${r.stderr || r.stdout}`)
  return r.stdout
}

function npmFound(spec) {
  try {
    return parseNpmView(run('npm', ['view', spec, 'version', '--json', '--prefer-online'])).found
  } catch (error) {
    throw new Error(`npm view ${spec} failed (${error.message})`)
  }
}

const show = (rev) => (path) => {
  const r = run('git', ['show', `${rev}:${path}`])
  return r.status === 0 ? r.stdout : null
}

function lookups(repo, sha) {
  const readMain = show('origin/main')
  return {
    sha,
    mainVersion: (dir) => parse(readMain(`packages/${dir}/package.json`))?.version ?? null,
    isPublished: (name, version) => npmFound(`${name}@${version}`),
    rangeAvailable: (name, range) => npmFound(`${name}@${range}`),
    branchSha: (branch) => {
      const out = capture('git', ['ls-remote', '--heads', 'origin', `refs/heads/${branch}`]).trim()
      return out ? out.split(/\s+/)[0] : null
    },
    publishRun: (branch, head) => {
      const fields = 'status,conclusion,url,headSha,displayTitle'
      const out = capture('gh', ['run', 'list', '-R', repo, '-w', 'publish-npm.yml', '-b', branch, '-L', '20', '--json', fields])
      return releaseRun(JSON.parse(out), head)
    },
    onMain: (commit) => run('git', ['merge-base', '--is-ancestor', commit, 'origin/main']).status === 0,
    minutesOld: (commit) => (Date.now() / 1000 - Number(capture('git', ['show', '-s', '--format=%ct', commit]).trim())) / 60,
  }
}

function bumpRows(env, repo) {
  if (env.SHA && !/^[0-9a-f]{7,40}$/.test(env.SHA)) throw new Error(`sha must be a commit hash, got ${env.SHA}`)
  const sha = capture('git', ['rev-parse', '--verify', `${env.SHA || 'HEAD'}^{commit}`]).trim()
  if (run('git', ['merge-base', '--is-ancestor', sha, 'origin/main']).status !== 0)
    throw new Error(`${sha} is not on main; only main commits are released`)
  const base = diffBase(sha, env.BEFORE)
  const changed = capture('git', ['diff', '--name-only', base, sha, '--', 'packages/*/package.json'])
    .split('\n')
    .filter(Boolean)
  const bumps = versionBumps({ changed, readBase: show(base), readHead: show(sha) })
  return { title: `Addon auto-release for ${sha.slice(0, 9)}`, rows: plan(bumps, lookups(repo, sha)) }
}

function scanRows(repo) {
  const heads = capture('git', ['ls-remote', '--heads', 'origin', 'refs/heads/release-*'])
    .split('\n')
    .filter(Boolean)
    .map((line) => {
      const [sha, ref] = line.split(/\s+/)
      return { sha, branch: ref.replace('refs/heads/', '') }
    })
  const pending = pendingBranches({ heads, readMain: show('origin/main') })
  const bumps = []
  const unreadable = []
  for (const { dir, version, sha } of pending) {
    run('git', ['fetch', '--no-tags', '--quiet', 'origin', sha])
    const manifest = parse(show(sha)(`packages/${dir}/package.json`))
    if (manifest?.version === version) bumps.push({ dir, name: manifest.name, from: null, version, sha, manifest })
    else {
      const reason = manifest ? `branch carries version ${manifest.version}` : 'could not read its package.json'
      unreadable.push({ dir, name: dir, version, sha, branch: `release-${dir}-${version}`, action: 'failed', reason })
    }
  }
  const rows = [...plan(bumps, lookups(repo, null)).filter(scanReports), ...unreadable]
  return { title: 'Waiting addon releases', rows }
}

function main() {
  const env = process.env
  const repo = env.GITHUB_REPOSITORY
  const dryRun = env.DRY_RUN === 'true'
  const { title, rows } = env.MODE === 'scan' ? scanRows(repo) : bumpRows(env, repo)
  const { publishRun } = lookups(repo, null)

  for (const row of rows) console.log(`${row.dir}@${row.version}: ${row.action}${row.reason ? ` (${row.reason})` : ''}`)
  apply(rows, {
    dryRun,
    create: (row) =>
      capture('gh', ['api', '--method', 'POST', `repos/${repo}/git/refs`, '-f', `ref=refs/heads/${row.branch}`, '-f', `sha=${row.sha}`]),
    // Re-checked right before dispatch so an overlapping run's publish is not started twice.
    start: (row) => {
      if (publishRun(row.branch, row.sha)) return false
      capture('gh', ['workflow', 'run', 'publish-npm.yml', '-R', repo, '--ref', row.branch, '-f', `packages=${row.dir}`])
    },
  })

  for (const row of rows.filter((r) => r.action === 'failed'))
    console.log(`::error title=Auto-release ${row.dir}::${row.reason}`)
  const text = summary(rows, { title, dryRun })
  if (env.GITHUB_STEP_SUMMARY) appendFileSync(env.GITHUB_STEP_SUMMARY, `${text}\n`)
  else console.log(`\n${text}`)
  if (rows.some((r) => r.action === 'failed')) process.exit(1)
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    main()
  } catch (error) {
    console.log(`::error title=Auto-release::${error.message}`)
    process.exit(1)
  }
}
