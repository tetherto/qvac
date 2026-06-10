'use strict'
// QVAC-19178: VLM benchmark entry. Filename is kept as `vlm-matrix.test.js` so the
// mobile generator still produces `runVlmMatrixTest` (registered in
// test/mobile/{test-groups,perf-tests}.json). The active mode/preset are decided in
// config.cjs + harness.cjs. Linux runs this in place; mobile runs a staged copy in
// test/integration (see stage.cjs).
const { runAll } = require('./harness.cjs')
runAll()
