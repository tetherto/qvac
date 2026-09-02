// Overrides the SDK's @qvac/inference dependency with the in-monorepo sibling
// for the "workspace" pod-check leg, so the SDK builds and tests against the
// engine at the same commit.

import { readFileSync, writeFileSync } from 'fs'
import { join, resolve, dirname } from 'path'
import { spawnSync } from 'child_process'
import { fileURLToPath } from 'url'

const sdkDir = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const inferenceDir = resolve(sdkDir, '..', 'inference')

function declaresInference() {
  const pkg = JSON.parse(readFileSync(join(sdkDir, 'package.json'), 'utf8')) as {
    dependencies?: Record<string, string>
  }
  return Boolean(pkg.dependencies?.['@qvac/inference'])
}

function run(command: string, args: string[], cwd: string) {
  const { status, error } = spawnSync(command, args, { cwd, stdio: 'inherit' })
  if (error) throw error
  if (status !== 0) process.exit(status ?? 1)
}

if (!declaresInference()) {
  console.log('[link-workspace-inference] @qvac/inference is not a dependency; skipping')
  process.exit(0)
}

run('bun', ['install'], inferenceDir)
run('bun', ['run', 'build'], inferenceDir)

const manifestPath = join(sdkDir, 'package.json')
const pkg = JSON.parse(readFileSync(manifestPath, 'utf8')) as {
  dependencies: Record<string, string>
}
pkg.dependencies['@qvac/inference'] = 'file:../inference'
writeFileSync(manifestPath, `${JSON.stringify(pkg, null, 2)}\n`)
run('bun', ['install'], sdkDir)
