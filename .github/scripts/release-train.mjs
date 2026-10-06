#!/usr/bin/env node
// Usage:
//   release-train.mjs resolve <ref> <base-sha> <head-sha> [--check-npm]
//   release-train.mjs linked <train>
//   release-train.mjs publish <moved-json> [--tag=<dist-tag>] [--dry-run]
//   release-train.mjs tag <train> <moved-json> [--push]
//
// resolve prints the train and the packages whose version moved between the two
// commits; publish and tag take that list. Inside a workflow the results go to
// GITHUB_OUTPUT.
import { appendFileSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { parseArgs } from 'node:util'
import {
  checkRelease,
  linkedOutsideTrain,
  loadTrain,
  movedProjects,
  parseBranch,
  parseLsRemote,
  planTags,
  readRepoJson,
  repoRoot,
  resolveDistTag,
  singleDistTag,
  slugOf,
  tagFor,
} from './lib/release-train.mjs'

const CATALOG = '.github/release-trains.json'

function run (command, args, options = {}) {
  const result = spawnSync(command, args, { cwd: repoRoot, encoding: 'utf8', maxBuffer: 1 << 28, ...options })
  if (result.error) throw result.error
  return result
}

function capture (command, args) {
  const result = run(command, args)
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

function resolveTrain ([ref, base, head], options) {
  const branch = parseBranch(ref ?? '')
  if (!branch || !base || !head) fail([`usage: resolve <release-train-<train>-x.y.z> <base-sha> <head-sha>; got '${ref}'`])
  const resolved = train(branch.train)
  const roots = projectRoots(resolved.projects)
  const projects = resolved.projects.map((name) => ({ name, dir: roots[name] }))
  const versionAt = (sha) => (project) => {
    const manifest = gitShow(sha, `${project.dir}/package.json`)
    return manifest && JSON.parse(manifest).version
  }
  const versionAtHead = (project) => {
    const version = versionAt(head)(project)
    if (!version) throw new Error(`${project.dir}/package.json does not exist at ${head}`)
    return version
  }

  const moved = movedProjects(projects, { base: versionAt(base), head: versionAtHead })
  if (moved.length === 0) {
    console.log('No train package moved between the two commits; nothing to release.')
  } else {
    const anchor = { name: resolved.anchorProjects[0], dir: roots[resolved.anchorProjects[0]] }
    const since = tagFor(anchor.name, versionAt(base)(anchor))
    if (run('git', ['rev-parse', '--verify', '--quiet', `refs/tags/${since}`]).status !== 0) {
      fail([`Tag ${since}, the last train release, is not in this checkout; fetch tags`])
    }
    const affected = JSON.parse(capture('pnpm', ['exec', 'nx', 'show', 'projects', '--affected', `--base=${since}`, `--head=${head}`, '--json']))
    const errors = checkRelease({
      branch,
      train: resolved,
      moved,
      versionAtHead: (name) => versionAtHead({ name, dir: roots[name] }),
      changelogAt: (project) => gitShow(head, `${project.dir}/CHANGELOG.md`),
      affected,
      versionPlans: capture('git', ['ls-tree', '-r', '--name-only', head, '--', '.nx/version-plans']).split('\n').filter(Boolean),
    })
    if (options['check-npm']) {
      for (const project of moved) {
        if (isPublished(project.name, project.version)) {
          errors.push(`${project.name}@${project.version} is already on npm; move it to a version npm does not have`)
        }
      }
    }
    if (errors.length) fail(errors)
    console.log(`Changed since ${since}: ${resolved.projects.filter((name) => affected.includes(name)).join(', ')}`)
    for (const project of moved) console.log(`moves ${project.name} to ${project.version}`)
  }

  const release = resolved.githubRelease && moved.find((project) => project.name === resolved.githubRelease.project)
  setOutputs({
    name: resolved.name,
    projects: resolved.projects.join(','),
    dist_paths: projects.map((project) => `${project.dir}/dist/`).join('\n'),
    moved: JSON.stringify(moved),
    release_slug: release ? slugOf(release.name) : '',
    release_dir: release ? release.dir : '',
    release_version: release ? release.version : '',
    release_name: release ? resolved.githubRelease.name : '',
  })
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

function publishTrain ([movedJson], options) {
  const moved = JSON.parse(movedJson ?? '[]')
  if (moved.length === 0) {
    console.log('Nothing to publish.')
    setOutputs({ published: false })
    return
  }
  const entries = moved.map((project) => ({
    ...project,
    onNpm: isPublished(project.name, project.version),
    tag: resolveDistTag({
      version: project.version,
      latest: npmView(project.name, 'dist-tags.latest'),
      requested: options.tag,
    }),
  }))
  const tag = singleDistTag(entries)
  for (const entry of entries) {
    console.log(`${entry.name}@${entry.version} -> ${tag}${entry.onNpm ? ' (already on npm)' : ''}`)
  }

  // One task graph, so nx publishes in dependency order and skips the
  // dependents of a package that failed. Without --exclude-task-dependencies
  // `^nx-release-publish` would also publish every workspace package the train
  // depends on.
  const args = ['exec', 'nx', 'run-many', '-t', 'nx-release-publish',
    `--projects=${moved.map((project) => project.name).join(',')}`,
    '--exclude-task-dependencies', `--tag=${tag}`]
  if (options['dry-run']) args.push('--dry-run')
  if (run('pnpm', args, { stdio: 'inherit' }).status !== 0) {
    fail(['Publish failed. Re-run the workflow: versions already on npm are skipped.'])
  }
  setOutputs({ published: !options['dry-run'] && entries.some((entry) => !entry.onNpm) })
}

function tagTrain ([name, movedJson], options) {
  const resolved = train(name)
  const head = capture('git', ['rev-parse', 'HEAD']).trim()
  const plan = planTags(JSON.parse(movedJson ?? '[]'), {
    releaseProject: resolved.githubRelease?.project,
    remoteCommit: (tag) => parseLsRemote(capture('git', ['ls-remote', '--tags', 'origin', `refs/tags/${tag}`, `refs/tags/${tag}^{}`]), tag),
    head,
  })
  for (const tag of plan.existing) console.log(`${tag} is already on origin at ${head}`)
  if (plan.conflicts.length) {
    fail(plan.conflicts.map(({ tag, commit }) => `${tag} is already on origin at ${commit}, expected ${head}`))
  }
  for (const tag of plan.create) {
    capture('git', ['tag', '--annotate', '--force', tag, '--message', tag])
    console.log(`created ${tag} at ${head}`)
  }
  if (plan.create.length && options.push) {
    capture('git', ['push', 'origin', ...plan.create.map((tag) => `refs/tags/${tag}`)])
  }
}

const { positionals, values } = parseArgs({
  allowPositionals: true,
  options: {
    'check-npm': { type: 'boolean', default: false },
    tag: { type: 'string', default: '' },
    'dry-run': { type: 'boolean', default: false },
    push: { type: 'boolean', default: false },
  },
})
const [command, ...rest] = positionals
const commands = { resolve: resolveTrain, linked: checkLinked, publish: publishTrain, tag: tagTrain }
if (!commands[command]) fail([`unknown command '${command}'; expected one of ${Object.keys(commands).join(', ')}`])
try {
  commands[command](rest, values)
} catch (error) {
  fail([error.message])
}
