#!/usr/bin/env node
// Checks the mobile tests and benchmark shards, mirrors the manifest's models into the US bucket and presigns them with
// the Laya model, then emits the host pre-stage commands that fetch them.

import { execFileSync } from 'node:child_process'
import { createRequire } from 'node:module'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { emitOutputs, emitPrestage, seedAndPresign } from '../../../scripts/ci/mobile-prestage.mjs'
import { dispatch } from './benchmark.mjs'

const PKG = fileURLToPath(new URL('..', import.meta.url))
const TEMP = process.env.RUNNER_TEMP
const sh = (cmd, args, env = process.env) =>
  execFileSync(cmd, args, { cwd: PKG, stdio: 'inherit', env })

// Advisory, as main ran it.
try {
  sh('npm', ['run', 'test:mobile:validate'])
} catch {
  console.log('::warning::test:mobile:validate failed; the mobile tests may be stale')
}
sh('npm', ['run', 'generate:benchmark-shards'])
sh('node', ['scripts/generate-benchmark-shards.js', '--assert-shards'])
const map = join(TEMP, 'embed-url-map.json')
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
// The Laya GGUF has no Hugging Face source, so it is presigned from the US bucket on its own.
sh('bash', ['scripts/generate-laya-presigned-url.sh'], { ...process.env, OUTPUT_DIR: TEMP })
emitPrestage(PKG, {
  env: {
    ...process.env,
    PRESTAGE_URL_MAP: map,
    PRESTAGE_S3_MODELS: join(TEMP, 'laya-model-urls.json')
  }
})

// A benchmarks.yml sweep run (BENCHMARK_ARGS) runs one of the sweep's mobile batches (batch=, else the first) instead
// of the regular groups.
if (process.env.BENCHMARK_ARGS) {
  const suite = dispatch(process.env.BENCHMARK_ARGS.split(/\s+/).filter(Boolean))
  if (suite.name === 'sweep') {
    const batches = require('../test/integration/_benchmark-matrix.js').workflowBatches()
    const batch =
      batches.find((b) => b.config === suite.values.batch) ??
      (suite.values.batch ? null : batches[0])
    if (!batch)
      throw new Error(
        `batch=${suite.values.batch} is not one of ${batches.map((b) => b.config).join(', ')}`
      )
    emitOutputs({ 'test-groups': JSON.stringify(batch.groups) })
  }
}
