// Decides how a lockfile change counts toward nx affected for one run.
//
// nx.json sets projectsAffectedByDependencyUpdates to [], so the lockfile selects
// nothing on its own. nx's other modes can't do what is needed: "all" selects
// every project on any lockfile change, "auto" reasons per external package and
// on the --stdin lane can't diff the lockfile at all, so both select every addon
// for a one-addon dependency bump.
//
// This selects exactly the workspace packages whose resolved dependency tree
// changed, by walking each importer through the lockfile's snapshots at base and
// head and comparing what it would install. Then it adds the workspace packages
// that depend on those (read from the manifests), because a consumer linking a
// changed package installs something different too, and nx's graph loses those
// edges after the --ignore-scripts install the action does.
//
// It keeps today's behaviour ("all") whenever it cannot attribute the change:
// the root manifest or a pnpm config file changed, the lockfile's settings or
// overrides changed, the root importer's tree changed, the lockfile could not be
// read or parsed, or it changed without any importer's tree changing.
//
// Usage: node lockfile-selection.mjs <repo-root> [<base-lock> <head-lock>]
// Changed paths on stdin, one per line. Prints {"mode": "all"|"", "extra": [...]}.
// Paths and lockfile text are only compared, never executed.
import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'

const [root = '.', baseLockPath, headLockPath] = process.argv.slice(2)
const paths = new Set(
  readFileSync(0, 'utf8')
    .split('\n')
    .map((p) => p.trim())
    .filter(Boolean)
)

// Files that change resolution for every package rather than one.
const GLOBAL = ['package.json', 'pnpm-workspace.yaml', '.npmrc', '.pnpmfile.cjs', '.pnpmfile.mjs']

const print = (mode, extra = []) => {
  process.stdout.write(`${JSON.stringify({ mode, extra })}\n`)
  process.exit(0)
}

if (!paths.has('pnpm-lock.yaml')) print('')
if (GLOBAL.some((f) => paths.has(f))) print('all')

// ---- workspace --------------------------------------------------------------

// Directories matched by pnpm-workspace.yaml's packages: list. Only exact paths
// and a trailing /* are used there, so only those are understood.
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

// ---- lockfile ---------------------------------------------------------------

const unquote = (s) => s.replace(/^'(.*)'$/, '$1').replace(/^"(.*)"$/, '$1')

// pnpm-lock.yaml v9 is regular two-space YAML, so it is read by indentation
// rather than with a YAML library, matching the no-dependency scripts here.
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

  // Split a section into its two-space keys. An entry may carry its body inline
  // on the key line, as `  foo@1.0.0: {}` or `  foo@1.0.0: {resolution: ...}`.
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

  // snapshots: key -> child snapshot keys
  const snapshots = new Map()
  for (const [key, body] of entries('snapshots')) {
    const children = []
    for (const line of body) {
      const dep = line.match(/^ {6}(\S+?):\s*(\S.*?)\s*$/)
      if (dep) children.push(`${unquote(dep[1])}@${unquote(dep[2])}`)
    }
    snapshots.set(key, children)
  }

  // packages: resolution by key without the peer suffix
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

// Everything an importer installs: each reachable snapshot, fingerprinted with
// its package's resolution so an integrity-only change still counts. link:
// entries are workspace packages, handled by the dependents walk instead.
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

// ---- decide -----------------------------------------------------------------

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

// An importer changed if its own block did (a dependency added, removed, re-ranged
// or re-linked) or if anything it installs did. The block alone misses a
// transitive change; the tree alone misses a new workspace link.
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

// The matrix loop reads packages/<name>/project.json and warns when it is
// absent, so emit only packages that have one there. The rest (plugins,
// registry clients, inference) are not nx projects and carry no rows.
print(
  '',
  [...selected]
    .map((dir) => [dir, pkg.get(dir).name.replace(/^@qvac\//, '')])
    .filter(([dir, name]) => dir === `packages/${name}` && existsSync(join(root, dir, 'project.json')))
    .map(([, name]) => name)
    .sort()
)
