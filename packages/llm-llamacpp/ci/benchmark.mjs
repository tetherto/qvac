#!/usr/bin/env node
// llm-llamacpp's benchmarks: suite=quality (benchmarks/run-benchmarks.sh against transformers), suite=sweep (the
// parameter sweep) or suite=vlm (the VLM model matrix), chosen in BENCHMARK_ARGS as key=value words. Each host's
// configuration lists the suites it serves with --suites; a host that serves none of the asked suite does nothing.

import { spawnSync } from 'node:child_process'
import { join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { parseArgs } from 'node:util'

const PKG = fileURLToPath(new URL('..', import.meta.url))

// Each suite's dispatch keys and their defaults, as main's workflow inputs had them.
export const SUITES = {
  quality: {
    script: 'ci/benchmark-quality.sh',
    keys: {
      gguf_model: 'unsloth/Qwen3-1.7B-GGUF:Q4_0',
      num_samples: '10',
      datasets: 'all',
      temperature: '0.7',
      ctx_size: '8192',
      gpu_layers: '99',
      top_p: '0.9',
      top_k: '40',
      n_predict: '4096',
      repeat_penalty: '1.0',
      seed: '-1',
      compare: 'true',
      transformers_model: 'Qwen/Qwen3-1.7B',
      device: 'gpu',
      verbose: 'true',
      addon_version: ''
    }
  },
  // batch picks one of _benchmark-matrix.js's mobile batches (a KV cache type, or batchsweep), as main ran them in turn.
  sweep: { script: 'ci/benchmark-sweep.sh', keys: { batch: 'f16' } },
  vlm: {
    script: 'ci/benchmark-vlm.sh',
    keys: {
      sources: 'addon',
      models: '',
      mode: 'two-models',
      preset: 'full',
      samples: '',
      mobile_timeout_min: '',
      baseline_npm: '',
      vlm_devices: 'cpu,gpu'
    }
  }
}

// key=value words; a value may hold anything but whitespace, and only reaches the scripts as an environment variable.
export function dispatch(words) {
  const out = {}
  for (const word of words) {
    const at = word.indexOf('=')
    if (at < 1) throw new Error(`BENCHMARK_ARGS word '${word}' is not key=value`)
    out[word.slice(0, at)] = word.slice(at + 1)
  }
  const suite = SUITES[out.suite]
  if (!suite) throw new Error(`BENCHMARK_ARGS needs suite=${Object.keys(SUITES).join('|')}`)
  const unknown = Object.keys(out).filter((k) => k !== 'suite' && !(k in suite.keys))
  if (unknown.length)
    throw new Error(
      `suite=${out.suite} takes ${Object.keys(suite.keys).join(', ')}; got ${unknown.join(', ')}`
    )
  return { name: out.suite, ...suite, values: { ...suite.keys, ...out } }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const suite = dispatch((process.env.BENCHMARK_ARGS ?? '').split(/\s+/).filter(Boolean))
  const { values: host } = parseArgs({
    args: process.argv.slice(2),
    options: {
      suites: { type: 'string' },
      'vlm-host': { type: 'string' },
      'vlm-backends': { type: 'string' }
    },
    strict: true
  })
  if (!(host.suites ?? '').split(',').includes(suite.name)) {
    console.log(`suite=${suite.name} does not run on this host (it serves ${host.suites})`)
    process.exit(0)
  }
  const env = {
    ...process.env,
    VLM_HOST: host['vlm-host'] ?? '',
    VLM_BACKENDS: host['vlm-backends'] ?? ''
  }
  for (const [k, v] of Object.entries(suite.values)) env[`BM_${k.toUpperCase()}`] = v
  const r = spawnSync('bash', [join(PKG, suite.script)], { cwd: PKG, env, stdio: 'inherit' })
  process.exit(r.status ?? 1)
}
