#!/usr/bin/env node
// diffusion's test:mobile, as main's mobile workflow prepared it: the advisory staleness check, the two models a phone
// downloads mirrored into the US bucket and presigned into the bundled manifest, and the generated images pulled back.

import { execFileSync } from 'node:child_process'
import { join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

import { emitOutputs, seedAndPresign } from '../../../scripts/ci/mobile-prestage.mjs'

const PKG = fileURLToPath(new URL('..', import.meta.url))
const MANIFEST = 'test/integration/models.manifest.json'
export const MOBILE_MODELS = ['stable-diffusion-v2-1-Q8_0.gguf', 'RealESRGAN_x4plus_anime_6B.pth']

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const env = process.env
  try {
    execFileSync('npm', ['run', 'test:mobile:validate'], { cwd: PKG, stdio: 'inherit' })
  } catch {
    console.log('::warning::test:mobile:validate failed; the mobile tests may be stale')
  }
  const map = join(env.RUNNER_TEMP, 'diffusion-url-map.json')
  seedAndPresign({
    pkg: PKG,
    manifest: MANIFEST,
    prefix: 'qvac_models_compiled/mobile-pilot/diffusion/',
    out: map,
    names: MOBILE_MODELS.join(',')
  })
  execFileSync(
    'node',
    [
      join(
        PKG,
        '../../.github/actions/run-mobile-integration-tests/seed-and-presign-models/rewrite-manifest-urls.mjs'
      )
    ],
    { stdio: 'inherit', env: { ...env, MANIFEST_PATH: join(PKG, MANIFEST), URL_MAP: map } }
  )
  emitOutputs({
    'after-hook-pulls': JSON.stringify([
      { device_path: 'tests/artifacts', artifact_name: 'generated-images' }
    ])
  })
}
