// Overrides the SDK's @qvac/inference dependency with the in-monorepo sibling
// for the "workspace" pod-check leg, so the SDK builds and tests against the
// engine at the same commit.
//
// Plain JavaScript: this runs before the SDK's own `npm install`, so nothing
// from node_modules (tsx included) is available yet.

import { readFileSync, writeFileSync } from 'fs'
import { join, resolve, dirname } from 'path'
import { spawnSync } from 'child_process'
import { fileURLToPath } from 'url'

const sdkDir = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const inferenceDir = resolve(sdkDir, '..', 'inference')

function declaresInference() {
  const pkg = JSON.parse(readFileSync(join(sdkDir, 'package.json'), 'utf8'))
  return Boolean(pkg.dependencies?.['@qvac/inference'])
}

// npm is a .cmd shim on Windows, which Node only spawns through a shell.
function npm(args, cwd) {
  const { status, error } = spawnSync('npm', args, {
    cwd,
    stdio: 'inherit',
    shell: process.platform === 'win32'
  })
  if (error) throw error
  if (status !== 0) process.exit(status ?? 1)
}

if (!declaresInference()) {
  console.log('[link-workspace-inference] @qvac/inference is not a dependency; skipping')
  process.exit(0)
}

// --ignore-scripts on both installs: CI writes a registry token into .npmrc
// before running this, so no dependency lifecycle script may run with it in
// reach. The engine's own prepare step is replaced by the explicit build below.
npm(['install', '--ignore-scripts'], inferenceDir)
npm(['run', 'build'], inferenceDir)

const manifestPath = join(sdkDir, 'package.json')
const pkg = JSON.parse(readFileSync(manifestPath, 'utf8'))
pkg.dependencies['@qvac/inference'] = 'file:../inference'
writeFileSync(manifestPath, `${JSON.stringify(pkg, null, 2)}\n`)
npm(['install', '--ignore-scripts'], sdkDir)
