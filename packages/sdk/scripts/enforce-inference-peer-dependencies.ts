// @qvac/inference peerDependencies is the source of truth for addon version
// ranges. The SDK should use the same version ranges as inference for addons.
// For every addon p in inference's peerDependencies, this script validates if:
//   - inference's devDependencies.p == inference's peerDependencies.p,
//   - SDK's dependencies.p == inference's peerDependencies.p.
// That is, inference's devDependencies and SDK's dependencies match inference's peerDependencies.

import { existsSync, readFileSync } from 'fs'
import { join, resolve, dirname } from 'path'
import { fileURLToPath } from 'url'

type Ranges = Record<string, string>

interface Manifest {
  dependencies?: Ranges
  devDependencies?: Ranges
  peerDependencies?: Ranges
}

const sdkDir = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const inferenceDir = resolve(sdkDir, '..', 'inference')

// The SDK e2e build checks out packages/sdk on its own and installs inference
// as a resolved package, so there is no sibling manifest to compare against.
// The full-checkout run in pr-checks-sdk-pod is what enforces this.
if (!existsSync(join(inferenceDir, 'package.json'))) {
  console.log('Skipping: packages/inference is not present in this checkout.')
  process.exit(0)
}

function readManifest(dir: string) {
  return JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8')) as Manifest
}

const inferencePkg = readManifest(inferenceDir)
const sdkPkg = readManifest(sdkDir)

const peers = inferencePkg.peerDependencies ?? {}
const inferenceDev = inferencePkg.devDependencies ?? {}
const sdkDeps = sdkPkg.dependencies ?? {}

const drifts: string[] = []
for (const [name, peer] of Object.entries(peers)) {
  const dev = inferenceDev[name]
  const dep = sdkDeps[name]
  const mismatches: string[] = []
  if (dep !== peer) mismatches.push(dep === undefined ? 'SDK is missing it' : `SDK has ${dep}`)
  if (dev !== peer) {
    mismatches.push(
      dev === undefined
        ? 'inference devDependencies is missing it'
        : `inference devDependencies has ${dev}`
    )
  }
  if (mismatches.length > 0) {
    drifts.push(
      `${name}: inference has it as ${peer} in peerDependencies, but ${mismatches.join(' and ')}.`
    )
  }
}

if (drifts.length > 0) {
  console.error(
    `${drifts.join('\n')}\n\nPlease ensure the SDK dependencies and inference devDependencies use the same addon versions as inference's peerDependencies.`
  )
  process.exit(1)
}
