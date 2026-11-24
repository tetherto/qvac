#!/usr/bin/env node
// Checks the mobile tests, mirrors the manifest's models into the US bucket and presigns them, then emits the host
// pre-stage commands that fetch them. The models share embed's mirror prefix, as the Device Farm project is embed's.

import { execFileSync } from 'node:child_process'
import { createRequire } from 'node:module'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { emitPrestage, seedAndPresign } from '../../../scripts/ci/mobile-prestage.mjs'

const PKG = fileURLToPath(new URL('..', import.meta.url))
const TEMP = process.env.RUNNER_TEMP
const sh = (cmd, args) => execFileSync(cmd, args, { cwd: PKG, stdio: 'inherit' })

// Advisory, as for the other addons.
try {
  sh('npm', ['run', 'test:mobile:validate'])
} catch {
  console.log('::warning::test:mobile:validate failed; the mobile tests may be stale')
}
const map = join(TEMP, 'decision-url-map.json')
const require = createRequire(import.meta.url)
seedAndPresign({
  pkg: PKG,
  manifest: 'test/integration/models.manifest.json',
  prefix: 'qvac_models_compiled/mobile-pilot/embed/',
  out: map,
  names: require('../scripts/generate-prestage-block.js')
    .mobileModelNames(require('../test/integration/models.manifest.json'))
    .join(',')
})
emitPrestage(PKG, { env: { ...process.env, PRESTAGE_URL_MAP: map } })
