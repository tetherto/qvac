#!/usr/bin/env node
// No git URLs, and no dev or tmp prerelease versions, in the dependencies of a package on the CI contract.
// @tetherto/* GitHub Packages builds are allowed: coordinated SDK and inference pull requests consume them before an
// npm release.

import { existsSync, mkdtempSync, readFileSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const file = join(mkdtempSync(join(tmpdir(), 'nx-graph-')), 'graph.json')
execFileSync('pnpm', ['exec', 'nx', 'graph', `--file=${file}`], {
  stdio: 'inherit',
  env: { ...process.env, NX_DAEMON: 'false', NX_NO_CLOUD: 'true' }
})
const nodes = Object.values(JSON.parse(readFileSync(file, 'utf8')).graph.nodes)
const roots = nodes.filter((n) => n.data.tags?.includes('ci:addons')).map((n) => n.data.root)
const errors = []
for (const root of roots) {
  const file = join(root, 'package.json')
  if (!existsSync(file)) continue
  const pkg = JSON.parse(readFileSync(file, 'utf8'))
  for (const [dep, value] of Object.entries({ ...pkg.dependencies, ...pkg.devDependencies })) {
    if (/^git\+https:\/\/github\.com/.test(value)) errors.push(`${file}: git URL ${dep}@${value}`)
    else if (!dep.startsWith('@tetherto/') && /^\d+\.\d+\.\d+-(dev|tmp)/.test(value))
      errors.push(`${file}: dev or tmp version ${dep}@${value}`)
  }
}
for (const e of errors) console.log(`::error::disallowed dependency: ${e}`)
if (errors.length) process.exit(1)
console.log(`${roots.length} packages on the contract, no disallowed dependency`)
