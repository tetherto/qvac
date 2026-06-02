'use strict'
// QVAC-19178: VLM matrix shard — Qwen3.5-0.8B (Q8_0) + mmproj Q8_0, cpu+gpu over the 5x5 fixture.
const { runVlmCell } = require('./_vlm-matrix-common.js')
runVlmCell('qwen', 'q8')
