#!/usr/bin/env node
// Fails when a range on a native provider (a package whose link:platform another target depends on) or on its platform
// packages excludes the provider's workspace version, since pnpm then installs the old release from npm instead. Other
// workspace ranges keep pnpm-workspace.yaml's registry fallback. Usage: node scripts/ci/check-workspace-ranges.mjs [root]

import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'

const FIELDS = ['dependencies', 'devDependencies', 'optionalDependencies', 'peerDependencies']

// The package directories pnpm-workspace.yaml's packages list names: dir/* globs, plain paths and !negations.
export function workspaceDirs(root) {
  const yaml = readFileSync(join(root, 'pnpm-workspace.yaml'), 'utf8')
  const list = yaml.slice(yaml.indexOf('packages:')).split('\n').slice(1)
  const dirs = new Set()
  for (const line of list) {
    const m = line.match(/^\s+-\s+["']?([^"'#\s]+)["']?/)
    if (!m) {
      if (/^\S/.test(line)) break
      continue
    }
    const negate = m[1].startsWith('!')
    const pattern = negate ? m[1].slice(1) : m[1]
    const found = pattern.endsWith('/*')
      ? readdirSync(join(root, pattern.slice(0, -2)), { withFileTypes: true })
          .filter((d) => d.isDirectory())
          .map((d) => `${pattern.slice(0, -2)}/${d.name}`)
      : [pattern]
    for (const dir of found) {
      if (negate) dirs.delete(dir)
      else if (existsSync(join(root, dir, 'package.json'))) dirs.add(dir)
    }
  }
  return [...dirs]
}

// Every package name a `#host-addon` import maps to, which publishes at the meta package's version.
export function platformPackages(manifest) {
  const names = []
  const walk = (v) => {
    if (typeof v === 'string') {
      if (v.startsWith('@')) names.push(v)
    } else if (v && typeof v === 'object') Object.values(v).forEach(walk)
  }
  walk(manifest.imports?.['#host-addon'])
  return names
}

const parse = (v) => {
  const m = String(v).match(/^v?(\d+)(?:\.(\d+|[xX*]))?(?:\.(\d+|[xX*]))?(?:-([0-9A-Za-z.-]+))?/)
  if (!m) return null
  const n = (s) => (s === undefined || /^[xX*]$/.test(s) ? null : Number(s))
  return { major: Number(m[1]), minor: n(m[2]), patch: n(m[3]), pre: m[4] ?? '' }
}
const cmp = (a, b) =>
  a.major - b.major ||
  (a.minor ?? 0) - (b.minor ?? 0) ||
  (a.patch ?? 0) - (b.patch ?? 0) ||
  (a.pre === b.pre ? 0 : !a.pre ? 1 : !b.pre ? -1 : a.pre < b.pre ? -1 : 1)

// One comparator set ("^1.2.3", ">=1.2.0 <2.0.0", "1.2.x") against a version.
function satisfiesSet(version, set) {
  const v = parse(version)
  for (const part of set.trim().split(/\s+/).filter(Boolean)) {
    const m = part.match(/^(\^|~|>=|<=|>|<|=)?(.*)$/)
    const op = m[1] ?? ''
    if (/^[xX*]?$/.test(m[2])) continue
    const r = parse(m[2])
    if (!r) throw new Error(`unsupported range "${set.trim()}"`)
    // A prerelease only satisfies a comparator on its own major.minor.patch, as in semver.
    if (v.pre && !(r.pre && v.major === r.major && v.minor === r.minor && v.patch === r.patch))
      return false
    const c = cmp(v, r)
    if (op === '>=' && c < 0) return false
    if (op === '<=' && c > 0) return false
    if (op === '>' && c <= 0) return false
    if (op === '<' && c >= 0) return false
    if (op === '^' || op === '~' || op === '' || op === '=') {
      if (c < 0) return false
      if (op === '^') {
        const same = r.major
          ? v.major === r.major
          : r.minor
            ? v.major === 0 && v.minor === r.minor
            : v.major === 0 && v.minor === 0 && (r.patch === null || v.patch === r.patch)
        if (!same) return false
      } else if (op === '~') {
        if (v.major !== r.major || (r.minor !== null && v.minor !== r.minor)) return false
      } else {
        if (v.major !== r.major) return false
        if (r.minor !== null && v.minor !== r.minor) return false
        if (r.patch !== null && v.patch !== r.patch) return false
        if (r.patch !== null && v.pre !== r.pre) return false
      }
    }
  }
  return true
}

export const satisfies = (version, range) =>
  range.split('||').some((set) => satisfiesSet(version, set.replace(/([<>=^~]+)\s+/g, '$1')))

// Ranges that are not semver (workspace:, file:, link:, npm: aliases, git and URLs) are pnpm's to resolve.
const isSemverRange = (range) =>
  !/^(workspace|file|link|npm|git|github|http|https|portal):|\//.test(range)

// The Nx project names that a target in any packages/*/project.json depends on for link:platform.
export function providerProjects(root) {
  const names = new Set()
  for (const d of readdirSync(join(root, 'packages'), { withFileTypes: true })) {
    const file = join(root, 'packages', d.name, 'project.json')
    if (!d.isDirectory() || !existsSync(file)) continue
    for (const target of Object.values(JSON.parse(readFileSync(file, 'utf8')).targets ?? {}))
      for (const dep of target.dependsOn ?? [])
        if (dep?.target === 'link:platform') for (const p of dep.projects ?? []) names.add(p)
  }
  return names
}

export function check(root) {
  const providers = providerProjects(root)
  const versions = new Map()
  const manifests = []
  for (const dir of workspaceDirs(root)) {
    const manifest = JSON.parse(readFileSync(join(root, dir, 'package.json'), 'utf8'))
    if (!manifest.name || !manifest.version) continue
    manifests.push({ dir, manifest })
    const project = existsSync(join(root, dir, 'project.json'))
      ? JSON.parse(readFileSync(join(root, dir, 'project.json'), 'utf8')).name
      : manifest.name
    if (!providers.has(project) && !providers.has(manifest.name)) continue
    versions.set(manifest.name, { version: manifest.version, of: manifest.name })
    for (const name of platformPackages(manifest))
      versions.set(name, { version: manifest.version, of: manifest.name })
  }
  const problems = []
  for (const { dir, manifest } of manifests)
    for (const field of FIELDS)
      for (const [dep, range] of Object.entries(manifest[field] ?? {})) {
        const ws = versions.get(dep)
        if (!ws || ws.of === manifest.name || !isSemverRange(range) || satisfies(ws.version, range))
          continue
        const what = ws.of === dep ? dep : `${dep} (a platform package of ${ws.of})`
        problems.push(
          `${dir}/package.json ${field}: ${what} is "${range}", which the workspace ${ws.of}@${ws.version} does not satisfy`
        )
      }
  return problems
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const problems = check(process.argv[2] ?? process.cwd())
  for (const p of problems) console.log(`::error::${p}`)
  if (problems.length) {
    console.log(
      `${problems.length} range(s) exclude a provider's workspace version; bump them with the provider.`
    )
    process.exit(1)
  }
  console.log("Every range on a provider includes the provider's workspace version.")
}
