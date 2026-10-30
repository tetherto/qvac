#!/usr/bin/env node
// pr-checks.yml's installs beside the workspace one: resolve finds the release train a run checks; install sets one package
// up alone with npm as main's pod checks did (npm, its sdk-source:workspace script, the train's tarballs, or npm's ranges);
// check installs it and runs each target. Usage: resolve | install <source> <dir> [tarballs] | check <source> <dir> <project> <targets> [tarballs]

import { appendFileSync, rmSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { join } from 'node:path'

const run = (cmd, args, opts = {}) => execFileSync(cmd, args, { stdio: 'inherit', ...opts })
const capture = (cmd, args) => execFileSync(cmd, args, { encoding: 'utf8' }).trim()
const TRAIN = '.github/scripts/release-train.mjs'

function resolve(env) {
  let train = env.TRAIN_INPUT || ''
  let source = train ? env.SOURCE_INPUT || 'train' : ''
  let ref = env.REF_INPUT || ''
  // A train's backmerge into the default branch carries the train's versions, so it checks the train too. A train
  // with fromNpm packages checks the published train instead: the commit npm records as its gitHead.
  const backmerge = (env.HEAD_REF || '').match(
    /^backmerge\/(release-train-([a-z0-9][a-z0-9-]*)-\d+\.\d+\.\d+)$/
  )
  if (
    !train &&
    backmerge &&
    env.BASE_REF === env.DEFAULT_BRANCH &&
    env.HEAD_REPO === env.REPOSITORY
  ) {
    train = backmerge[2]
    source = 'train'
    if (capture('node', [TRAIN, 'from-npm', train]) !== '[]') {
      source = 'published'
      ref = capture('node', [TRAIN, 'published-commit', backmerge[1]])
    }
  }
  const projects = train ? capture('node', [TRAIN, 'projects', train]) : ''
  console.log(train ? `Train ${train}, source ${source}, projects ${projects}` : 'No release train')
  appendFileSync(
    env.GITHUB_OUTPUT,
    `train=${train}\nsource=${source}\nref=${ref}\nprojects=${projects}\n`
  )
}

// Main's order: workspace's script is the install; train stages before installing; both npm sources then run the
// package's sdk-source:<source> script if it has one.
function install([source, dir, tarballs]) {
  if (!['npm', 'workspace', 'train', 'published'].includes(source) || !dir)
    throw new Error('usage: install <npm|workspace|train|published> <package-dir> [tarball-dir]')
  run('git', ['checkout', 'HEAD', '--', 'package.json'], { cwd: dir })
  rmSync(join(dir, 'node_modules'), { recursive: true, force: true })
  rmSync(join(dir, 'package-lock.json'), { force: true })
  if (source === 'workspace') return run('npm', ['run', 'sdk-source:workspace'], { cwd: dir })
  if (source === 'train') {
    if (!tarballs) throw new Error('the train source needs the tarball directory')
    run('node', [TRAIN, 'stage', dir, tarballs])
  }
  // --ignore-scripts: a dependency's lifecycle script would run with the registry token in reach.
  run('npm', ['install', '--ignore-scripts'], { cwd: dir })
  if (source !== 'npm') run('npm', ['run', '--if-present', `sdk-source:${source}`], { cwd: dir })
}

// check installs the package from one source, then runs each target with its dependencies excluded, since the other
// workspace packages are not installed; a failed target fails the run after the rest have run, as main's checks did.
function check([source, dir, project, targets, tarballs]) {
  install([source, dir, tarballs])
  let failed = 0
  for (const target of targets.split(',').filter(Boolean)) {
    try {
      // The installs above rewrite manifests pnpm's lockfile does not know, so pnpm must not reinstall before nx.
      run('pnpm', [
        '--config.verify-deps-before-run=false',
        'exec',
        'nx',
        'run-many',
        '-t',
        target,
        '-p',
        project,
        '--exclude-task-dependencies',
        '--outputStyle=stream'
      ])
    } catch {
      console.log(`::error::${project} ${target} failed with the ${source} source`)
      failed++
    }
  }
  if (failed) process.exit(1)
}

const [command, ...args] = process.argv.slice(2)
if (command === 'resolve') resolve(process.env)
else if (command === 'install') install(args)
else if (command === 'check') check(args)
else
  throw new Error(
    'usage: checks-source.mjs resolve | install <source> <dir> [tarballs] | check <source> <dir> <project> <targets> [tarballs]'
  )
