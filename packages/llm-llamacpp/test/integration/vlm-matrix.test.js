'use strict'
// QVAC-19178: VLM benchmark matrix — loops {2 models x 2 mmproj} x {cpu,gpu} over the
// frozen 5x5 fixture. One file => one mobile test fn (runVlmMatrixTest) => one Device
// Farm spec => single-spec dual-flagship => Samsung S25. On Linux, QVAC_VLM_DEVICES /
// NO_GPU select the device per runner. Gated/sized in _vlm-matrix-common.js.
const { runAllCells } = require('./_vlm-matrix-common.js')
runAllCells()
