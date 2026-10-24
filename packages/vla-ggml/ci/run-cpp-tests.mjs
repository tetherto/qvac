#!/usr/bin/env node
// Runs addon-test, then fails when GR00T parity was staged but skipped, a no-op behind a green check.

import { appendFileSync, existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'

import { modelEnv, PKG } from './model-env.mjs'
import { tee } from './tee.mjs'

const UNIT = join(PKG, 'build/test/unit')

// Each GGUF is paired with the oracle dumped from the same checkpoint.
export const MODELS = {
  GROOT_TEST_GGUF: 'groot-libero-q8_vf16.gguf',
  GROOT_TEST_ACTIVATIONS_V4: 'groot-libero-activations_v4.safetensors',
  GROOT_TEST_SWEEP_GGUF: 'groot-multi-q8_vf16.gguf',
  GROOT_TEST_SWEEP_ACTIVATIONS: 'groot-multi-activations_sweep.safetensors'
}

export function check({ log, xml, env }) {
  const errors = []
  const count = (xml.match(/<testcase/g) || []).length
  if (!count) errors.push('no tests were executed')
  const skipped = log.split('\n').filter((l) => l.startsWith('[  SKIPPED ] Groot'))
  if (env.GROOT_TEST_GGUF && skipped.length) {
    errors.push(`GR00T artefacts are staged but Groot tests were skipped:\n${skipped.join('\n')}`)
  }
  const sweep = log.split('\n').filter((l) => l.includes('[GrootEmbodimentSweep]'))
  if (env.GROOT_TEST_SWEEP_GGUF && !sweep.length) {
    errors.push('GROOT_TEST_SWEEP_GGUF is set but the embodiment sweep produced no rows')
  }
  return { count, sweep, errors }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const binary = process.platform === 'win32' ? 'addon-test.exe' : 'addon-test'
  if (!existsSync(join(UNIT, binary))) throw new Error(`addon-test not built under ${UNIT}`)
  const env = { ...process.env, ...modelEnv(MODELS) }
  const { code, log } = await tee('npm', ['run', 'test:cpp:run'], {
    cwd: PKG,
    env,
    logFile: join(UNIT, 'test-output.log')
  })
  if (code !== 0) process.exit(code)
  const xmlPath = join(UNIT, 'cpp-test-results.xml')
  const r = check({ log, xml: existsSync(xmlPath) ? readFileSync(xmlPath, 'utf8') : '', env })
  if (r.errors.length) {
    for (const e of r.errors) console.log(`::error::${e}`)
    process.exit(1)
  }
  console.log(
    `${r.count} tests ran${r.sweep.length ? `, ${r.sweep.length} embodiment rows checked` : ''}`
  )
  if (
    r.sweep.length &&
    process.env.GITHUB_STEP_SUMMARY &&
    process.platform === 'linux' &&
    process.arch === 'x64'
  ) {
    appendFileSync(
      process.env.GITHUB_STEP_SUMMARY,
      `## GR00T multi-embodiment sweep\n\n${r.sweep.length} rows checked against the PyTorch oracle.\n\n\`\`\`\n${r.sweep.slice(0, 17).join('\n')}\n\`\`\`\n`
    )
  }
}
