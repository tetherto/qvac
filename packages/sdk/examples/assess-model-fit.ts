/**
 * Which models fit this machine, asked before downloading any weights. Each
 * engine's fitter reads the registry's weightless description of a model, so
 * nothing is fetched beyond tens of KB, loaded or reserved.
 *
 * Each model gets its own verdict and the memory it takes on each device, and
 * the set gets one verdict for all of them loaded together, with what it takes
 * from each memory pool. `unknown` is a valid answer: show it as "can't say",
 * never as "no".
 */

import {
  assessModelFit,
  QWEN3_600M_INST_Q4,
  QWEN3_1_7B_INST_Q4,
  QWEN3_4B_INST_Q4_K_M,
  QWEN3_8B_INST_Q4_K_M,
  QWEN3_8_27B_MULTIMODAL_UD_Q8_K_XL
} from '@qvac/sdk'

// The fitter sizes the load as `loadModel` would run it, context included.
const CONTEXT_TOKENS = 8192

// A ladder ending well past what a laptop has, so one screen shows every verdict.
const CANDIDATES = [
  QWEN3_600M_INST_Q4,
  QWEN3_1_7B_INST_Q4,
  QWEN3_4B_INST_Q4_K_M,
  QWEN3_8B_INST_Q4_K_M,
  QWEN3_8_27B_MULTIMODAL_UD_Q8_K_XL
]

const VERDICT_MARK: Record<string, string> = {
  fits: '✔',
  'does-not-fit': '✖',
  unknown: '?'
}

function gib(bytes: number) {
  return `${(bytes / 1024 ** 3).toFixed(2)} GiB`
}

try {
  const result = await assessModelFit({
    models: CANDIDATES.map((model) => ({
      modelSrc: model,
      modelType: 'llamacpp-completion' as const,
      modelConfig: { ctx_size: CONTEXT_TOKENS }
    }))
  })

  console.log(`▸ At ${CONTEXT_TOKENS} tokens of context, each model alone`)
  for (const [index, model] of result.models.entries()) {
    const candidate = CANDIDATES[index]!
    const size = gib(candidate.expectedSize).padStart(9)
    console.log(`  ${VERDICT_MARK[model.status]} ${candidate.name.padEnd(46)} ${size} on disk`)
    for (const device of model.devices) {
      console.log(`      ${device.name.padEnd(10)} ${gib(device.usedBytes).padStart(10)}`)
    }
  }

  console.log(`\n▸ All five loaded together: ${result.verdict}`)
  for (const pool of result.pools) {
    const free = pool.freeBytes === undefined ? 'no free figure' : `of ${gib(pool.freeBytes)} free`
    console.log(`  ${pool.id.padEnd(14)} ${gib(pool.usedBytes).padStart(10)} ${free}`)
  }
  process.exit(0)
} catch (error) {
  console.error('✖', error)
  process.exit(1)
}
