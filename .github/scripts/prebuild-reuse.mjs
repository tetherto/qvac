#!/usr/bin/env node
// Splits _build's rows into legs to build and legs an earlier run on this branch or on the default branch already built
// from the same native code and build inputs, so a rerun only builds what failed or changed. A failed lookup builds it.

import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { appendFileSync } from 'node:fs'
import { pathToFileURL } from 'node:url'

// The package's and its providers' native code (a consumer links its providers' prebuilds); package.json names the
// addon and project.json holds the build commands and per-configuration settings.
export const NATIVE =
  /\.(c|cc|cpp|cxx|h|hh|hpp|hxx|inl|ipp|cu|cuh|m|mm|S|asm)$|(^|\/)CMakeLists\.txt$|\.cmake$|(^|\/)vcpkg(-configuration)?\.json$|\/vcpkg\/|(^|\/)(package|project)\.json$/

// What decides a leg's key. Each part is hashed on its own, so a leg that has to build can log which part changed.
//   row       the build row: package, configuration, runner, providers
//   native    the package's and its providers' native files (NATIVE above)
//   lockfile  only the packages those packages install, from pnpm's reading of the lockfile (lockfilePart)
//   actions   only the local actions _build.yml uses (actionsUsed)
//   shared    files every build reads, whatever the package (INPUTS)

export const INPUTS = [
  'cmake',
  'vcpkg-overlays',
  'nx.json',
  'pnpm-workspace.yaml',
  'scripts/ci',
  '.github/bare-toolchain',
  '.github/config',
  '.github/workflows/_build.yml'
]

const hash = (text) => createHash('sha256').update(text).digest('hex').slice(0, 16)

// The leg's packages and every package they install, one 'name@version tarball' line each, from
// `pnpm list --lockfile-only --json` (pnpm reads the lockfile; nothing is installed). A change anywhere else in the
// lockfile leaves this text the same.
export function lockfilePart(projects) {
  const lines = new Set()
  const walk = (deps = {}) => {
    for (const [name, dep] of Object.entries(deps)) {
      lines.add(`${name}@${dep.version} ${dep.resolved ?? ''}`)
      walk(dep.dependencies)
      walk(dep.optionalDependencies)
    }
  }
  for (const project of projects) {
    lines.add(`${project.name}@${project.version}`)
    walk(project.dependencies)
    walk(project.devDependencies)
    walk(project.optionalDependencies)
  }
  return [...lines].sort().join('\n')
}

// The local actions _build.yml uses, and the local actions those use in turn.
export function actionsUsed(read) {
  const found = new Set()
  const scan = (yaml) => {
    for (const [, name] of yaml.matchAll(/uses: \.\/\.github\/actions\/([A-Za-z0-9_-]+)/g)) {
      const dir = `.github/actions/${name}`
      if (found.has(dir)) continue
      found.add(dir)
      scan(read(`${dir}/action.yml`) || read(`${dir}/action.yaml`))
    }
  }
  scan(read('.github/workflows/_build.yml'))
  return [...found].sort()
}

// tree(paths) lists files with their content hashes (git ls-tree), read(path) returns one file's text, and
// pnpmList(dirs) returns `pnpm list --lockfile-only --json` for those packages.
export function keyParts(row, { tree, read, pnpmList }) {
  const dirs = [row.dir, ...(row.providers ?? []).map((p) => `packages/${p}`)]
  const nativeFiles = tree(dirs)
    .split('\n')
    .filter((line) => NATIVE.test(line.split('\t')[1] ?? ''))
  return {
    row: hash(JSON.stringify(row)),
    native: hash(nativeFiles.join('\n')),
    lockfile: hash(lockfilePart(pnpmList(dirs))),
    actions: hash(tree(actionsUsed(read))),
    shared: hash(tree(INPUTS))
  }
}

export const legKey = (row, ctx) => hash(JSON.stringify(keyParts(row, ctx)))

export const cacheName = (row, key) => `prebuild-cache-${row.slug}-${row.config}-${key}`

// Only an unexpired artifact from a same-repository run on this branch or the default branch, never one a fork's run
// produced; cache-warm builds the default branch's.
export function pick(artifacts, branch, defaultBranch = '') {
  return (
    artifacts.find(
      (a) =>
        !a.expired &&
        [branch, defaultBranch].filter(Boolean).includes(a.workflow_run?.head_branch) &&
        a.workflow_run.head_repository_id === a.workflow_run.repository_id
    ) ?? null
  )
}

// Rows come in as index-aligned slug, config, dir, runner and providers lists: whole rows overflow one variable.
export function legs({ slugs, configs, dirs, runners, providers = [] }) {
  return slugs.map((slug, i) => ({
    slug,
    config: configs[i],
    dir: dirs[i],
    runner: runners[i],
    providers: providers[i] ?? []
  }))
}

// Legs to build go back as their row index, which _build reads the full row by.
export async function plan(rows, { tree, read, pnpmList, list, branch, defaultBranch = '' }) {
  const build = []
  const reused = []
  for (const [i, row] of rows.entries()) {
    const parts = keyParts(row, { tree, read, pnpmList })
    const name = cacheName(row, hash(JSON.stringify(parts)))
    const hit = branch ? pick(await list(name), branch, defaultBranch) : null
    if (hit) reused.push({ slug: row.slug, config: row.config, name, runId: hit.workflow_run.id })
    else build.push({ i, cacheName: name, parts })
  }
  return { build, reused }
}

async function main(env) {
  const tree = (paths) =>
    execFileSync('git', ['-C', env.SRC, 'ls-tree', '-r', 'HEAD', '--', ...paths], {
      encoding: 'utf8',
      maxBuffer: 256 * 1024 * 1024
    })
  const read = (path) => {
    try {
      return execFileSync('git', ['-C', env.SRC, 'show', `HEAD:${path}`], {
        encoding: 'utf8',
        maxBuffer: 256 * 1024 * 1024,
        stdio: ['ignore', 'pipe', 'ignore']
      })
    } catch {
      return ''
    }
  }
  // SRC can be a pull request's code: ignore-pnpmfile keeps pnpm from running its .pnpmfile.cjs.
  const pnpmList = (dirs) =>
    JSON.parse(
      execFileSync(
        'pnpm',
        [
          'list',
          '--lockfile-only',
          '--config.ignore-pnpmfile=true',
          '--depth',
          'Infinity',
          '--json',
          ...dirs.flatMap((d) => ['--filter', `./${d}`])
        ],
        { cwd: env.SRC, encoding: 'utf8', maxBuffer: 256 * 1024 * 1024 }
      )
    )
  const list = async (name) => {
    const url = `${env.GITHUB_API_URL}/repos/${env.GITHUB_REPOSITORY}/actions/artifacts?name=${encodeURIComponent(name)}&per_page=30`
    const res = await fetch(url, {
      headers: { authorization: `Bearer ${env.GH_TOKEN}`, accept: 'application/vnd.github+json' }
    })
    if (!res.ok) {
      console.log(`::warning::artifact lookup for ${name} failed (${res.status}); building it`)
      return []
    }
    return (await res.json()).artifacts ?? []
  }
  const slugs = JSON.parse(env.SLUGS)
  const providers = JSON.parse(env.PROVIDERS || '[]')
  // A list that does not line up with the rows would key legs on the wrong providers, so nothing is reused then.
  const aligned = providers.length === slugs.length && providers.every(Array.isArray)
  if (!aligned) console.log('::warning::provider lists do not line up with the build rows; building every leg')
  const branch = env.REUSE === 'true' && aligned ? env.BRANCH : ''
  const rows = legs({
    slugs,
    configs: JSON.parse(env.CONFIGS),
    dirs: JSON.parse(env.DIRS),
    runners: JSON.parse(env.RUNNERS),
    providers: aligned ? providers : []
  })
  const { build, reused } = await plan(rows, {
    tree,
    read,
    pnpmList,
    list,
    branch,
    defaultBranch: env.DEFAULT_BRANCH
  })
  for (const r of reused) console.log(`reuse ${r.slug} ${r.config} from run ${r.runId}`)
  // Compare these with the default branch's cache-warm log to see which input moved.
  for (const b of build) console.log(`build ${b.cacheName}: ${JSON.stringify(b.parts)}`)
  console.log(`${build.length} to build, ${reused.length} reused`)
  appendFileSync(
    env.GITHUB_OUTPUT,
    `build=${JSON.stringify(build.map(({ i, cacheName }) => ({ i, cacheName })))}\nreused=${JSON.stringify(reused)}\n`
  )
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href)
  await main(process.env)
