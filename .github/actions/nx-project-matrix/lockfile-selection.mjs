// Decides how a lockfile change counts toward nx affected for one run.
//
// nx.json sets projectsAffectedByDependencyUpdates to [], so the lockfile selects
// nothing on its own: pnpm rewrites shared entries across most importers on a
// one-line dependency change, so letting it select would pull in the workspace.
// A dependency bump is still selected through the package.json it edits.
//
// Two corrections, both keyed on manifests listed by pnpm-workspace.yaml:
//
//   mode "all"  pnpm-lock.yaml changed and nothing explains it, either because no
//               workspace package manifest changed or because the root one did
//               (root devDependencies are tooling for everything). Keep today's
//               behaviour rather than narrow.
//
//   extra       pnpm-lock.yaml changed with a workspace manifest behind it. Add
//               every package that depends on the changed ones, read from the
//               manifests. nx's own graph is not reliable for this after a
//               --ignore-scripts install: the addons' edges to @qvac/fabric are
//               missing, so a fabric bump would test fabric alone.
//
// Changed paths on stdin, one per line. Prints {"mode": "all"|"", "extra": [...]}.
// Paths are compared, never executed.
import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'

const root = process.argv[2] ?? '.'
const paths = new Set(
  readFileSync(0, 'utf8')
    .split('\n')
    .map((p) => p.trim())
    .filter(Boolean)
)

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

const dirs = workspaceDirs()
const manifestOf = new Map(dirs.map((dir) => [`${dir}/package.json`, dir]))
const pkg = new Map(dirs.map((dir) => [dir, JSON.parse(readFileSync(join(root, dir, 'package.json'), 'utf8'))]))
const dirOf = new Map([...pkg].map(([dir, json]) => [json.name, dir]))

const changed = [...paths].filter((p) => manifestOf.has(p)).map((p) => manifestOf.get(p))

let mode = ''
let extra = []

if (paths.has('pnpm-lock.yaml')) {
  if (paths.has('package.json') || changed.length === 0) {
    mode = 'all'
  } else {
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

    const seen = new Set(changed)
    const queue = [...changed]
    while (queue.length) {
      const name = pkg.get(queue.shift()).name
      for (const dir of dependents.get(name) ?? []) {
        if (!seen.has(dir)) {
          seen.add(dir)
          queue.push(dir)
        }
      }
    }
    for (const dir of changed) seen.delete(dir)

    // The matrix loop reads packages/<name>/project.json and warns when it is
    // absent, so emit only packages that have one there. The rest (plugins,
    // registry clients, inference) are not nx projects and carry no rows.
    extra = [...seen]
      .map((dir) => [dir, pkg.get(dir).name.replace(/^@qvac\//, '')])
      .filter(([dir, name]) => dir === `packages/${name}` && existsSync(join(root, dir, 'project.json')))
      .map(([, name]) => name)
      .sort()
  }
}

process.stdout.write(`${JSON.stringify({ mode, extra })}\n`)
