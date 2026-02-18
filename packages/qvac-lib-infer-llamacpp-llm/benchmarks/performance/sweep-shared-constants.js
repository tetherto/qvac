'use strict'

// Keep default sweep compact for practical runtimes.
const DEFAULT_SWEEP_CTX_SIZES = [2048]
const DEFAULT_SWEEP_BATCH_SIZES = [512, 2048]

// Keep prompt fixtures broad so common CLI overrides remain usable.
const PROMPT_CTX_SIZES = [2048, 4096, 8192]
const PROMPT_BATCH_SIZES = [512, 2048, 4096, 8192]
const N_PREDICT_RESERVE = 1024
const PROMPT_OVERHEAD_RESERVE = 128

module.exports = {
  DEFAULT_SWEEP_CTX_SIZES,
  DEFAULT_SWEEP_BATCH_SIZES,
  PROMPT_CTX_SIZES,
  PROMPT_BATCH_SIZES,
  N_PREDICT_RESERVE,
  PROMPT_OVERHEAD_RESERVE
}
