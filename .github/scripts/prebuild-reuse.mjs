#!/usr/bin/env node
// Splits _build's rows into legs to build and legs an earlier run on this branch already built from the same native
// code and build inputs, so a rerun only builds what failed or changed. A failed lookup builds the leg.

import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { appendFileSync } from 'node:fs'
import { pathToFileURL } from 'node:url'

// The package's and fabric's native code (fabric is built in every consumer job); package.json names the addon and
// project.json holds the build commands and per-configuration settings.
export const NATIVE =
  /\.(c|cc|cpp|cxx|h|hh|hpp|hxx|inl|ipp|cu|cuh|m|mm|S|asm)$|(^|\/)CMakeLists\.txt$|\.cmake$|(^|\/)vcpkg(-configuration)?\.json$|\/vcpkg\/|(^|\/)(package|project)\.json$/

// Build inputs, every file: shared CMake and vcpkg code, toolchain pins, lockfile and install layout, and the CI code.
export const INPUTS = [
  'cmake',
  'vcpkg-overlays',
  'nx.json',
  'pnpm-lock.yaml',
  'pnpm-workspace.yaml',
  'scripts/ci',
  '.github/actions',
  '.github/config',
  '.github/workflows/_build.yml'
]

export function legKey(row, tree) {
  const native = tree([row.dir, 'packages/fabric'])
    .split('\n')
    .filter((line) => NATIVE.test(line.split('\t')[1] ?? ''))
    .join('\n')
  return createHash('sha256')
    .update(JSON.stringify(row))
    .update(native)
    .update(tree(INPUTS))
    .digest('hex')
    .slice(0, 16)
}

export const cacheName = (row, key) => `prebuild-cache-${row.slug}-${row.config}-${key}`

// Only an unexpired artifact from a same-repository run on this branch, never one a fork's run produced.
export function pick(artifacts, branch) {
  return (
    artifacts.find(
      (a) =>
        !a.expired &&
        a.workflow_run?.head_branch === branch &&
        a.workflow_run.head_repository_id === a.workflow_run.repository_id
    ) ?? null
  )
}

// Rows come in as index-aligned slug, config, dir and runner lists: whole rows overflow one environment variable.
export function legs({ slugs, configs, dirs, runners }) {
  return slugs.map((slug, i) => ({ slug, config: configs[i], dir: dirs[i], runner: runners[i] }))
}

// Legs to build go back as their row index, which _build reads the full row by.
export async function plan(rows, { tree, list, branch }) {
  const build = []
  const reused = []
  for (const [i, row] of rows.entries()) {
    const name = cacheName(row, legKey(row, tree))
    const hit = branch ? pick(await list(name), branch) : null
    if (hit) reused.push({ slug: row.slug, config: row.config, name, runId: hit.workflow_run.id })
    else build.push({ i, cacheName: name })
  }
  return { build, reused }
}

async function main(env) {
  const tree = (paths) =>
    execFileSync('git', ['-C', env.SRC, 'ls-tree', '-r', 'HEAD', '--', ...paths], {
      encoding: 'utf8',
      maxBuffer: 256 * 1024 * 1024
    })
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
  const branch = env.REUSE === 'true' ? env.BRANCH : ''
  const rows = legs({
    slugs: JSON.parse(env.SLUGS),
    configs: JSON.parse(env.CONFIGS),
    dirs: JSON.parse(env.DIRS),
    runners: JSON.parse(env.RUNNERS)
  })
  const { build, reused } = await plan(rows, { tree, list, branch })
  for (const r of reused) console.log(`reuse ${r.slug} ${r.config} from run ${r.runId}`)
  console.log(`${build.length} to build, ${reused.length} reused`)
  appendFileSync(
    env.GITHUB_OUTPUT,
    `build=${JSON.stringify(build)}\nreused=${JSON.stringify(reused)}\n`
  )
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href)
  await main(process.env)
