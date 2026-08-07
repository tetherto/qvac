#!/usr/bin/env node
'use strict'

// Expands a package's compact options.ci.rtfBenchmark.comboGroups into the full
// RTF matrix (combos x cpu/gpu) and writes it to the runner's own matrix env var
// via $GITHUB_ENV, so the package benchmark script runs unchanged.

function expandRtfMatrix (comboGroups, { noGpu, gpuBackend }) {
  const out = []
  for (const group of comboGroups) {
    const cleaned = group.map(({ gpu, ...rest }) => ({ rest, gpuEligible: gpu !== false }))
    for (const { rest } of cleaned) out.push({ ...rest, useGPU: false, backendHint: 'cpu' })
    if (!noGpu) {
      for (const { rest, gpuEligible } of cleaned) {
        if (gpuEligible) out.push({ ...rest, useGPU: true, backendHint: gpuBackend })
      }
    }
  }
  return out
}

function stampLabels (matrix, { device, runner }) {
  return matrix.map((e) => ({
    ...e,
    ...(device ? { deviceLabel: device } : {}),
    ...(runner ? { runnerLabel: runner } : {})
  }))
}

function buildFromEnv (env) {
  const comboGroups = JSON.parse(env.QVAC_RTF_COMBO_GROUPS_JSON)
  if (!Array.isArray(comboGroups)) throw new Error('QVAC_RTF_COMBO_GROUPS_JSON must be a JSON array')
  const noGpu = env.QVAC_RTF_NO_GPU === 'true' || env.QVAC_RTF_NO_GPU === '1'
  const matrix = expandRtfMatrix(comboGroups, { noGpu, gpuBackend: env.QVAC_RTF_GPU_BACKEND || 'vulkan' })
  return stampLabels(matrix, { device: env.QVAC_RTF_DEVICE, runner: env.QVAC_RTF_RUNNER })
}

function main () {
  const fs = require('fs')
  const env = process.env
  const line = `${env.QVAC_RTF_TARGET_ENV}=${JSON.stringify(buildFromEnv(env))}`
  if (env.GITHUB_ENV) fs.appendFileSync(env.GITHUB_ENV, line + '\n')
  else console.log(line)
}

if (require.main === module) main()

module.exports = { expandRtfMatrix, stampLabels, buildFromEnv }
