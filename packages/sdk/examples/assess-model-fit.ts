/**
 * Which models is this machine likely to run — asked before downloading any
 * weights. Nothing is fetched, loaded or reserved.
 *
 * The header prints the evidence the answer rests on: `system-memory` on a
 * CPU-only or integrated-GPU host, `device-memory` on a discrete card,
 * `device-budget` for the per-process allowance Windows grants on one. Which
 * of those applies depends on where the engine would put the model.
 *
 * `unknown` is a real answer, not an error: the evidence does not support a
 * call either way. Show it as "can't say", never as "no".
 */

import {
  assessModelFit,
  QWEN3_600M_INST_Q4,
  QWEN3_1_7B_INST_Q4,
  QWEN3_4B_INST_Q4_K_M,
  QWEN3_8B_INST_Q4_K_M,
  QWEN3_8_27B_MULTIMODAL_UD_Q8_K_XL
} from '@qvac/sdk'

// `as const` so `kind` stays the `'llm'` literal the input type asks for.
const WORKLOAD = { kind: 'llm', contextTokens: 8192 } as const

// A ladder ending well past what a laptop has, so one screen shows every verdict.
const CANDIDATES = [
  QWEN3_600M_INST_Q4,
  QWEN3_1_7B_INST_Q4,
  QWEN3_4B_INST_Q4_K_M,
  QWEN3_8B_INST_Q4_K_M,
  QWEN3_8_27B_MULTIMODAL_UD_Q8_K_XL
]

const VERDICT_MARK: Record<string, string> = {
  'likely-fits': '✔',
  'likely-too-large': '✖',
  unknown: '?'
}

function gib(bytes: number) {
  return `${(bytes / 1024 ** 3).toFixed(2)} GiB`
}

try {
  const result = await assessModelFit({
    models: CANDIDATES.map((model) => ({ model, workload: WORKLOAD })),
    // Declared for aggregation only, not a scheduling instruction: 'sequential'
    // counts the largest operation peak, 'concurrent' counts one per model.
    execution: 'sequential',
    policy: 'interactive-v1'
  })

  console.log(`▸ Budget basis: ${result.basis}`)
  if (result.budget) {
    console.log(
      `    ${gib(result.budget.availableAfterReserveBytes)} budget` +
        ` (${gib(result.budget.totalBytes)} total,` +
        ` ${gib(result.budget.usedBytes)} in use,` +
        ` ${gib(result.budget.availableBytes)} free,` +
        ` ${gib(result.budget.reservedBytes)} held back)`
    )
  }

  // Says which device the verdicts assume, when the model would run on a GPU.
  const placement = result.assumptions.find((line: string) =>
    line.includes('assumed to execute on')
  )
  if (placement) console.log(`▸ ${placement}`)

  console.log(`\n▸ At ${WORKLOAD.contextTokens} tokens of context`)
  for (const [index, model] of result.models.entries()) {
    const mark = VERDICT_MARK[model.verdict]
    const size = gib(CANDIDATES[index]!.expectedSize).padStart(9)
    const needs = model.estimate ? `needs ${gib(model.estimate.upperBoundBytes)}` : ''
    console.log(`  ${mark} ${model.name.padEnd(46)} ${size} on disk  ${needs}`)
    // Present on every `unknown`, and worth surfacing: it names what is missing.
    if (model.verdict === 'unknown') {
      for (const reason of model.reasons) console.log(`      ${reason}`)
    }
  }

  console.log(`\n▸ All five together, sequentially: ${result.verdict}`)
  console.log('▸ Advisory only — this does not gate loadModel or reserve anything.')
  process.exit(0)
} catch (error) {
  console.error('✖', error)
  process.exit(1)
}
