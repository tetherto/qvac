'use strict'
// QVAC-19178: VLM matrix shard — gemma-4-E2B (IQ4_XS) + mmproj f16, cpu+gpu over the 5x5 fixture.
const { runVlmCell } = require('./_vlm-matrix-common.js')
runVlmCell('gemma', 'f16')
