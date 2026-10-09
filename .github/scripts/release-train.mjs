#!/usr/bin/env node
// Usage:
//   release-train.mjs resolve <ref> <base-sha> <head-sha> [--check-npm]
//   release-train.mjs slugs <train>
//   release-train.mjs projects <train>
//   release-train.mjs linked <train>
//   release-train.mjs pack <train> <dest-dir>
//   release-train.mjs stage <package-dir> <tarball-dir>
//   release-train.mjs publish <moved-json> [--tarballs=<dir>] [--dry-run]
//   release-train.mjs wait <moved-json>
//   release-train.mjs tag <train> <moved-json> [--push]
//
// resolve prints the train and the packages whose version moved between the two
// commits; publish, wait and tag take that list. Inside a workflow the results
// go to GITHUB_OUTPUT.
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { spawnSync } from 'node:child_process'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { parseArgs } from 'node:util'
import {
  checkRelease,
  compareVersions,
  linkedOutsideTrain,
  loadTrain,
  movedProjects,
  parseBranch,
  parseLsRemote,
  planTags,
  publishedElsewhere,
  readRepoJson,
  repoRoot,
  slugOf,
  stageManifest,
} from './lib/release-train.mjs'

const CATALOG = '.github/release-trains.json'
const TARBALL_INDEX = 'tarballs.json'

function run (command, args, options = {}) {
  const result = spawnSync(command, args, { cwd: repoRoot, encoding: 'utf8', maxBuffer: 1 << 28, ...options })
  if (result.error) throw result.error
  return result
}

function capture (command, args, options) {
  const result = run(command, args, options)
  if (result.status !== 0) {
    throw new Error(`${command} ${args.join(' ')} failed (exit ${result.status}): ${result.stderr || result.stdout}`)
  }
  return result.stdout
}

function gitShow (sha, path) {
  const result = run('git', ['show', `${sha}:${path}`])
  return result.status === 0 ? result.stdout : null
}

// E404 means both "no such package" and "no such version".
function npmView (spec, field) {
  const result = run('npm', ['view', spec, field, '--json', '--prefer-online'])
  if (result.status !== 0) {
    let code
    try {
      code = JSON.parse(result.stdout).error?.code
    } catch {}
    if (code === 'E404') return null
    throw new Error(`npm view ${spec} failed (exit ${result.status}): ${result.stderr || result.stdout}`)
  }
  return result.stdout.trim() ? JSON.parse(result.stdout) : null
}

function isPublished (name, version) {
  return npmView(`${name}@${version}`, 'version') !== null
}

function setOutputs (outputs) {
  if (!process.env.GITHUB_OUTPUT) {
    console.log(JSON.stringify(outputs, null, 2))
    return
  }
  for (const [key, value] of Object.entries(outputs)) {
    appendFileSync(process.env.GITHUB_OUTPUT, `${key}<<__OUTPUT__\n${value}\n__OUTPUT__\n`)
  }
}

function fail (errors) {
  for (const error of errors) console.error(`::error::${error}`)
  process.exit(1)
}

function train (name) {
  return loadTrain(name, readRepoJson(CATALOG), readRepoJson('nx.json'))
}

function projectRoots (names) {
  const dir = mkdtempSync(join(tmpdir(), 'release-train-'))
  try {
    capture('pnpm', ['exec', 'nx', 'graph', `--file=${join(dir, 'graph.json')}`])
    const { nodes } = JSON.parse(readFileSync(join(dir, 'graph.json'), 'utf8')).graph
    return Object.fromEntries(names.map((name) => {
      if (!nodes[name]) throw new Error(`nx has no project named ${name}`)
      return [name, nodes[name].data.root]
    }))
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

// npm records the commit a version was built from. Written the same way when
// packing and when publishing, so both produce the same tarball.
function stampGitHead (dir, sha) {
  const path = join(repoRoot, dir, 'package.json')
  const original = readFileSync(path, 'utf8')
  writeFileSync(path, JSON.stringify({ ...JSON.parse(original), gitHead: sha }, null, 2) + '\n')
  return () => writeFileSync(path, original)
}

function sha1 (path) {
  return createHash('sha1').update(readFileSync(path)).digest('hex')
}

function resolveTrain ([ref, base, headRef], options) {
  const branch = parseBranch(ref ?? '')
  if (!branch || !base || !headRef) fail([`usage: resolve <release-train-<train>-x.y.z> <base-sha> <head-sha>; got '${ref}'`])
  const head = capture('git', ['rev-parse', headRef]).trim()
  const resolved = train(branch.train)
  const roots = projectRoots(resolved.projects)
  const projects = resolved.projects.map((name) => ({ name, dir: roots[name] }))
  const manifestAt = (sha, project) => {
    const manifest = gitShow(sha, `${project.dir}/package.json`)
    return manifest && JSON.parse(manifest)
  }
  const versionAtHead = (project) => {
    const manifest = manifestAt(head, project)
    if (!manifest) throw new Error(`${project.dir}/package.json does not exist at ${head}`)
    return manifest.version
  }

  const moved = movedProjects(projects, { base: (project) => manifestAt(base, project)?.version ?? null, head: versionAtHead })
  if (moved.length === 0) {
    console.log('No train package moved between the two commits; nothing to release.')
  } else {
    const errors = checkRelease({
      branch,
      train: resolved,
      moved,
      versionAtHead: (name) => versionAtHead({ name, dir: roots[name] }),
      changelogAt: (project) => gitShow(head, `${project.dir}/CHANGELOG.md`),
      versionPlans: capture('git', ['ls-tree', '-r', '--name-only', head, '--', '.nx/version-plans']).split('\n').filter(Boolean),
      manifests: Object.fromEntries(projects.map((project) => [project.name, manifestAt(head, project)])),
    })
    if (options['check-npm']) {
      for (const project of moved) {
        if (isPublished(project.name, project.version)) {
          errors.push(`${project.name}@${project.version} is already on npm; move it to a version npm does not have`)
        }
      }
    } else {
      errors.push(...publishedElsewhere(moved, (project) => npmView(`${project.name}@${project.version}`, 'gitHead'), head))
    }
    if (errors.length) fail(errors)
    for (const project of moved) console.log(`moves ${project.name} to ${project.version}`)
  }

  const release = resolved.githubRelease && moved.find((project) => project.name === resolved.githubRelease.project)
  setOutputs({
    name: resolved.name,
    projects: resolved.projects.join(','),
    dist_paths: projects.map((project) => `${project.dir}/dist/`).join('\n'),
    moved: JSON.stringify(moved),
    checks: JSON.stringify(resolved.checks),
    release_slug: release ? slugOf(release.name) : '',
    release_dir: release ? release.dir : '',
    release_version: release ? release.version : '',
    release_name: release ? resolved.githubRelease.name : '',
  })
}

function printSlugs ([name]) {
  console.log(JSON.stringify(train(name).projects.map(slugOf)))
}

function printProjects ([name]) {
  console.log(train(name).projects.join(','))
}

function checkLinked ([name]) {
  const resolved = train(name)
  const list = (filter, depth) => JSON.parse(capture('pnpm', ['--filter', filter, 'list', '--depth', depth, '--json']))[0]
  const deps = linkedOutsideTrain(resolved.projects, (project) => {
    const entry = list(project, '0')
    return ['dependencies', 'optionalDependencies', 'peerDependencies'].flatMap((field) =>
      Object.entries(entry?.[field] ?? {}).map(([dep, resolution]) => ({ name: dep, version: resolution.version ?? '' })))
  })
  const errors = []
  for (const dep of deps) {
    const { version } = list(dep.name, '-1')
    if (isPublished(dep.name, version)) {
      console.log(`${dep.name}@${version} is on npm (linked by ${dep.dependents.join(', ')})`)
    } else {
      errors.push(`${dep.name}@${version} is linked from the workspace but not on npm. ` +
        `${dep.dependents.join(', ')} would build against code no consumer can install. Release it first, or lower the range.`)
    }
  }
  if (errors.length) fail(errors)
}

function packTrain ([name, dest]) {
  if (!dest) fail(['usage: pack <train> <dest-dir>'])
  const resolved = train(name)
  const roots = projectRoots(resolved.projects)
  const head = capture('git', ['rev-parse', 'HEAD']).trim()
  const out = resolve(dest)
  mkdirSync(out, { recursive: true })
  const index = {}
  for (const project of resolved.projects) {
    const dir = roots[project]
    const dist = join(repoRoot, dir, 'dist')
    if (!existsSync(dist) || !readdirSync(dist).length) throw new Error(`${dir}/dist is empty; build it first`)
    const before = new Set(readdirSync(out))
    const restore = stampGitHead(dir, head)
    try {
      capture('pnpm', ['pack', '--pack-destination', out], { cwd: join(repoRoot, dir), env: { ...process.env, PNPM_CONFIG_IGNORE_SCRIPTS: 'true' } })
    } finally {
      restore()
    }
    const [file] = readdirSync(out).filter((entry) => !before.has(entry))
    index[project] = file
    console.log(`packed ${project} as ${file} (sha1 ${sha1(join(out, file))})`)
  }
  writeFileSync(join(out, TARBALL_INDEX), JSON.stringify(index, null, 2) + '\n')
}

function stagePackage ([dir, tarballDir]) {
  if (!dir || !tarballDir) fail(['usage: stage <package-dir> <tarball-dir>'])
  const index = JSON.parse(readFileSync(join(tarballDir, TARBALL_INDEX), 'utf8'))
  const tarballs = Object.fromEntries(Object.entries(index).map(([name, file]) => [name, resolve(tarballDir, file)]))
  const path = join(resolve(dir), 'package.json')
  writeFileSync(path, JSON.stringify(stageManifest(JSON.parse(readFileSync(path, 'utf8')), tarballs), null, 2) + '\n')
  console.log(`${path}: ${Object.keys(tarballs).join(', ')} resolve from ${resolve(tarballDir)}`)
}

function publishTrain ([movedJson], options) {
  const moved = JSON.parse(movedJson ?? '[]')
  const head = capture('git', ['rev-parse', 'HEAD']).trim()
  const errors = []
  const pending = []
  for (const project of moved) {
    if (isPublished(project.name, project.version)) {
      console.log(`${project.name}@${project.version} is already on npm; skipped`)
      continue
    }
    const latest = npmView(project.name, 'dist-tags.latest')
    if (latest && compareVersions(project.version, latest) < 0) {
      errors.push(`${project.name}@${project.version} is below npm's latest ${latest}; release an older line through its own workflow`)
    }
    pending.push(project)
  }
  if (errors.length) fail(errors)
  if (pending.length === 0) {
    console.log('Nothing to publish.')
    setOutputs({ published: false })
    return
  }

  const restores = pending.map((project) => stampGitHead(project.dir, head))
  try {
    // One task graph, so nx publishes in dependency order and skips the
    // dependents of a package that failed. Without --exclude-task-dependencies
    // `^nx-release-publish` would also publish every workspace package the
    // train depends on.
    const args = ['exec', 'nx', 'run-many', '-t', 'nx-release-publish',
      `--projects=${pending.map((project) => project.name).join(',')}`,
      '--exclude-task-dependencies', '--tag=latest', '--access=public']
    if (options['dry-run']) args.push('--dry-run')
    if (run('pnpm', args, { stdio: 'inherit' }).status !== 0) {
      fail(['Publish failed. Re-run the workflow: versions already on npm are skipped.'])
    }
  } finally {
    restores.forEach((restore) => restore())
  }

  if (!options['dry-run'] && options.tarballs) {
    const index = JSON.parse(readFileSync(join(options.tarballs, TARBALL_INDEX), 'utf8'))
    for (const project of pending) {
      const expected = sha1(join(options.tarballs, index[project.name]))
      const actual = npmView(`${project.name}@${project.version}`, 'dist.shasum')
      if (actual !== expected) errors.push(`${project.name}@${project.version} on npm has sha1 ${actual}; the built tarball has ${expected}`)
    }
    if (errors.length) fail(errors)
  }
  setOutputs({ published: !options['dry-run'] })
}

// A registry error counts as "not served yet": the versions are already
// published, so the only outcome that matters is whether npm serves them in time.
function waitServed ([movedJson]) {
  const moved = JSON.parse(movedJson ?? '[]')
  const deadline = Date.now() + 10 * 60 * 1000
  for (const project of moved) {
    for (;;) {
      let served = false
      try {
        served = isPublished(project.name, project.version)
      } catch (error) {
        console.log(error.message)
      }
      if (served) break
      if (Date.now() > deadline) fail([`npm does not serve ${project.name}@${project.version} after 10 minutes`])
      spawnSync('sleep', ['10'])
    }
    console.log(`npm serves ${project.name}@${project.version}`)
  }
}

function tagTrain ([name, movedJson], options) {
  const resolved = train(name)
  const plan = planTags(JSON.parse(movedJson ?? '[]'), {
    releaseProject: resolved.githubRelease?.project,
    remoteCommit: (tag) => parseLsRemote(capture('git', ['ls-remote', '--tags', 'origin', `refs/tags/${tag}`, `refs/tags/${tag}^{}`]), tag),
    gitHeadOf: (project) => {
      const gitHead = npmView(`${project.name}@${project.version}`, 'gitHead')
      if (!gitHead) throw new Error(`${project.name}@${project.version} has no gitHead on npm`)
      return gitHead
    },
  })
  for (const tag of plan.existing) console.log(`${tag} is already on origin at its npm gitHead`)
  if (plan.conflicts.length) {
    fail(plan.conflicts.map(({ tag, commit, expected }) => `${tag} is already on origin at ${commit}, npm says ${expected}`))
  }
  for (const { tag, commit } of plan.create) {
    capture('git', ['tag', '--annotate', '--force', tag, commit, '--message', tag])
    console.log(`created ${tag} at ${commit}`)
  }
  if (plan.create.length && options.push) {
    capture('git', ['push', 'origin', ...plan.create.map(({ tag }) => `refs/tags/${tag}`)])
  }
}

const { positionals, values } = parseArgs({
  allowPositionals: true,
  options: {
    'check-npm': { type: 'boolean', default: false },
    tarballs: { type: 'string' },
    'dry-run': { type: 'boolean', default: false },
    push: { type: 'boolean', default: false },
  },
})
const [command, ...rest] = positionals
const commands = {
  resolve: resolveTrain,
  slugs: printSlugs,
  projects: printProjects,
  linked: checkLinked,
  pack: packTrain,
  stage: stagePackage,
  publish: publishTrain,
  wait: waitServed,
  tag: tagTrain,
}
if (!commands[command]) fail([`unknown command '${command}'; expected one of ${Object.keys(commands).join(', ')}`])
try {
  commands[command](rest, values)
} catch (error) {
  fail([error.message])
}
