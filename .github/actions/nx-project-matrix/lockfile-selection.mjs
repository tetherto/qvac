// Selects the workspace packages whose installed dependencies changed between two
// lockfiles, plus their workspace dependents. Prints {"mode": "all"|"", "extra": [...]}.
// Usage: node lockfile-selection.mjs <root> [<base-lock> <head-lock> [<base-ws> <head-ws>]] < paths
import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'

const [root = '.', baseLockPath, headLockPath, baseWsPath, headWsPath] = process.argv.slice(2)
const paths = new Set(
  readFileSync(0, 'utf8')
    .split('\n')
    .map((p) => p.trim())
    .filter(Boolean)
)

const GLOBAL = ['package.json', '.npmrc', '.pnpmfile.cjs', '.pnpmfile.mjs']

// pnpm-workspace.yaml keys whose effect shows up in the lockfile.
const RECORDED_IN_LOCK = new Set(['overrides', 'packages', 'minimumReleaseAgeExclude'])

const print = (mode, extra = []) => {
  process.stdout.write(`${JSON.stringify({ mode, extra })}\n`)
  process.exit(0)
}

if (!paths.has('pnpm-lock.yaml')) print('')
if (GLOBAL.some((f) => paths.has(f))) print('all')

function topLevel(text) {
  const out = new Map()
  let key = null
  for (const line of text.split('\n')) {
    const m = line.match(/^([A-Za-z][\w-]*):/)
    if (m) {
      key = m[1]
      out.set(key, [line])
    } else if (key && line.trim() && !line.trim().startsWith('#')) {
      out.get(key).push(line)
    }
  }
  return new Map([...out].map(([k, lines]) => [k, lines.join('\n')]))
}

if (paths.has('pnpm-workspace.yaml')) {
  try {
    if (!baseWsPath || !headWsPath) throw new Error('pnpm-workspace.yaml revisions not provided')
    const before = topLevel(readFileSync(baseWsPath, 'utf8'))
    const after = topLevel(readFileSync(headWsPath, 'utf8'))
    const keys = new Set([...before.keys(), ...after.keys()])
    if ([...keys].some((k) => before.get(k) !== after.get(k) && !RECORDED_IN_LOCK.has(k))) print('all')
  } catch {
    print('all')
  }
}

// Supports exact paths and a trailing /* only.
function workspaceDirs() {
  const yaml = readFileSync(join(root, 'pnpm-workspace.yaml'), 'utf8')
  const block = (yaml.split(/^packages:\s*$/m)[1] ?? '').split(/^\S/m)[0]
  const dirs = []
  for (const [, glob] of block.matchAll(/^\s*-\s*["']?([^"'\s]+)["']?\s*$/gm)) {
    if (glob.endsWith('/*')) {
      const base = glob.slice(0, -2)
      if (!existsSync(join(root, base))) continue
      for (const entry of readdirSync(join(root, base), { withFileTypes: true })) {
        if (entry.isDirectory() && existsSync(join(root, base, entry.name, 'package.json'))) {
          dirs.push(`${base}/${entry.name}`)
        }
      }
    } else if (existsSync(join(root, glob, 'package.json'))) {
      dirs.push(glob)
    }
  }
  return dirs
}

const unquote = (s) => s.replace(/^'(.*)'$/, '$1').replace(/^"(.*)"$/, '$1')

// Indentation reader for pnpm-lock.yaml v9.
function parseLock(text) {
  const lines = text.split('\n')
  const section = {}
  let top = null
  for (const line of lines) {
    const m = line.match(/^([A-Za-z]+):/)
    if (m) {
      top = m[1]
      section[top] = []
      continue
    }
    if (top) section[top].push(line)
  }

  // Bodies may be inline: `  foo@1.0.0: {}`.
  const entries = (name) => {
    const out = new Map()
    let key = null
    for (const line of section[name] ?? []) {
      const m = line.match(/^ {2}(\S.*):(?: (\{.*\}))?\s*$/)
      if (m) {
        key = unquote(m[1])
        out.set(key, m[2] ? [m[2]] : [])
        continue
      }
      if (key && line.trim()) out.get(key).push(line)
    }
    return out
  }

  const importers = new Map()
  const importerText = new Map()
  for (const [dir, body] of entries('importers')) {
    importerText.set(dir, body.join('\n'))
    const deps = []
    let name = null
    for (const line of body) {
      const dep = line.match(/^ {6}(\S.*):\s*$/)
      if (dep) {
        name = unquote(dep[1])
        continue
      }
      const ver = line.match(/^ {8}version:\s*(.+?)\s*$/)
      if (ver && name) deps.push(`${name}@${unquote(ver[1])}`)
    }
    importers.set(dir, deps)
  }

  const snapshots = new Map()
  for (const [key, body] of entries('snapshots')) {
    const children = []
    for (const line of body) {
      const dep = line.match(/^ {6}(\S+?):\s*(\S.*?)\s*$/)
      if (dep) children.push(`${unquote(dep[1])}@${unquote(dep[2])}`)
    }
    snapshots.set(key, children)
  }

  const packages = new Map([...entries('packages')].map(([k, body]) => [k, body.join('\n')]))

  if (importers.size === 0) throw new Error('no importers parsed')
  return {
    importers,
    importerText,
    snapshots,
    packages,
    header: ['settings', 'overrides'].map((s) => (section[s] ?? []).join('\n')).join('\n--\n'),
  }
}

// What an importer installs, with resolutions. link: entries are left to the dependents walk.
function tree(lock, dir) {
  const seen = new Set()
  const queue = [...(lock.importers.get(dir) ?? [])]
  const out = []
  while (queue.length) {
    const key = queue.shift()
    if (seen.has(key)) continue
    seen.add(key)
    if (/@link:/.test(key)) continue
    const bare = key.replace(/\(.*$/, '')
    out.push(`${key}|${lock.packages.get(bare) ?? ''}`)
    queue.push(...(lock.snapshots.get(key) ?? []))
  }
  return out.sort().join('\n')
}

let base
let head
try {
  if (!baseLockPath || !headLockPath) throw new Error('lockfile revisions not provided')
  base = parseLock(readFileSync(baseLockPath, 'utf8'))
  head = parseLock(readFileSync(headLockPath, 'utf8'))
} catch {
  print('all')
}

if (base.header !== head.header) print('all')

const changed = [...new Set([...base.importers.keys(), ...head.importers.keys()])].filter(
  (dir) =>
    base.importerText.get(dir) !== head.importerText.get(dir) || tree(base, dir) !== tree(head, dir)
)
if (changed.includes('.') || changed.length === 0) print('all')

const dirs = workspaceDirs()
const pkg = new Map(dirs.map((dir) => [dir, JSON.parse(readFileSync(join(root, dir, 'package.json'), 'utf8'))]))
const dirOf = new Map([...pkg].map(([dir, json]) => [json.name, dir]))

const dependents = new Map()
for (const [dir, json] of pkg) {
  for (const field of ['dependencies', 'devDependencies', 'peerDependencies', 'optionalDependencies']) {
    for (const name of Object.keys(json[field] ?? {})) {
      if (!dirOf.has(name)) continue
      if (!dependents.has(name)) dependents.set(name, new Set())
      dependents.get(name).add(dir)
    }
  }
}

const selected = new Set(changed.filter((dir) => pkg.has(dir)))
const queue = [...selected]
while (queue.length) {
  for (const dir of dependents.get(pkg.get(queue.shift()).name) ?? []) {
    if (!selected.has(dir)) {
      selected.add(dir)
      queue.push(dir)
    }
  }
}

// Only packages the matrix loop can read.
print(
  '',
  [...selected]
    .map((dir) => [dir, pkg.get(dir).name.replace(/^@qvac\//, '')])
    .filter(([dir, name]) => dir === `packages/${name}` && existsSync(join(root, dir, 'project.json')))
    .map(([, name]) => name)
    .sort()
)
