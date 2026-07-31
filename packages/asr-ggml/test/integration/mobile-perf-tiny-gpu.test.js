'use strict'

const test = require('brittle')
const { runMobilePerfCase } = require('./mobile-perf-runner.js')

// NOTE: this case is deliberately ordered LAST in the mobile suite (see
// test/mobile/integration.auto.cjs — `runMobilePerfTinyGpuTest` is the final
// entry). Whisper's GPU teardown has historically crashed the bare app on
// Samsung Galaxy S25 Ultra (State=1 after-test in the Device Farm wdio crash
// detector; see WhisperConfig.cpp + whisper.cpp#2373 re: ggml backend static
// cleanup at process exit). The Device Farm runs both devices off one spec, so
// we cannot skip per-device. Running this case last means that if the Samsung
// teardown still crashes, it cannot drop any *other* test's coverage on that
// device — every earlier case has already reported. The mobile job itself is
// `continue-on-error: true`, so this is also non-blocking for the PR.
//
// We enable it on Android (previously quarantined skip-as-pass) specifically to
// PROVE the dynamic GPU backend engages on the Device Farm matrix:
//   Pixel 9 (Mali)    -> Vulkan  (backendId 3)
//   Samsung S25 (Adreno) -> OpenCL (backendId 4)
// The assertions live in runMobilePerfCase (mobile-perf-runner.js). NO_GPU=true
// still skips the GPU half on runners without a real GPU.
test('Mobile perf tiny GPU', { timeout: 600000 }, async (t) => {
  await runMobilePerfCase(t, {
    modelFile: 'ggml-tiny.bin',
    useGPU: true
  })
})
