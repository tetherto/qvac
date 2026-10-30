// Shared by packages' ci/prepare-mobile.mjs: the Device Farm host's model pre-stage block, from the package's
// scripts/generate-prestage-block.js, as the pre-test-commands output _mobile.yml hands to the test spec.

import { appendFileSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { join } from 'node:path'

export function emitPrestage(pkg, { platform = process.env.PLATFORM, env = process.env } = {}) {
  const block = execFileSync(
    'node',
    [join(pkg, 'scripts/generate-prestage-block.js'), platform.toLowerCase()],
    { cwd: pkg, encoding: 'utf8', env }
  )
  appendFileSync(env.GITHUB_OUTPUT, `pre-test-commands<<PRESTAGE_EOF\n${block}\nPRESTAGE_EOF\n`)
}

// Mirrors the manifest's models into the US bucket where missing, then presigns them into a name -> URL map, through
// main's seed-and-presign script. The job's AWS session must cover both.
export function seedAndPresign({ pkg, manifest, prefix, out, names = '', env = process.env }) {
  const script = join(
    pkg,
    '../../.github/actions/run-mobile-integration-tests/seed-and-presign-models/seed-and-presign.mjs'
  )
  execFileSync('node', [script], {
    stdio: 'inherit',
    env: {
      ...env,
      MANIFEST_PATH: join(pkg, manifest),
      S3_BUCKET: env.MODEL_S3_BUCKET,
      S3_PREFIX: prefix,
      OUTPUT_MAP: out,
      MODEL_NAMES: names,
      MODE: 'both'
    }
  })
}

// Step outputs _mobile.yml reads from test:mobile: test-groups, device-env, mocha-timeout-ms, per-test-timeout-minutes.
export function emitOutputs(outputs, env = process.env) {
  for (const [k, v] of Object.entries(outputs))
    appendFileSync(env.GITHUB_OUTPUT, `${k}<<EOF_OUT\n${v}\nEOF_OUT\n`)
}
