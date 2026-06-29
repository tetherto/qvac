'use strict'

const proc = require('bare-process')

// Enable the GPU paths in gpu-smoke.test.js on Device Farm. The desktop
// integration-test workflow toggles GPU via a matrix `no_gpu` -> job env, but
// mobile bundles execute on real devices where workflow env vars do not
// propagate, so set it here. 'false' keeps the GPU smoke enabled so CI
// exercises whisper.cpp's dynamic GPU backend init on real hardware (Metal on
// iOS, Vulkan/OpenCL on Android). Flip to 'true' to force the CPU-only path.
proc.env.NO_GPU = 'false'

console.log('[integration-runtime] BCI Whispercpp mobile integration tests initialized')
