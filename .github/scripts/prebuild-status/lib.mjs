// Status keys and the job outcome to status mapping for pr-build-test.yml's status jobs.

export const PREBUILD_KEYS = [
  'asr-ggml',
  'bci-whispercpp',
  'classification-ggml',
  'diffusion-cpp',
  'embed-llamacpp',
  'fabric',
  'ggml-rpc-server',
  'llm-llamacpp',
  'model-fit',
  'ocr-ggml',
  'translation-nmtcpp',
  'tts-ggml',
  'turbovec-ggml',
  'vla-ggml',
]

// Status keys for C++/fuzz suites. audiogen-ggml's suite is a config-parse fuzz target, with no prebuild.
export const CPP_TEST_KEYS = [
  'asr-ggml',
  'audiogen-ggml',
  'bci-whispercpp',
  'classification-ggml',
  'diffusion-cpp',
  'embed-llamacpp',
  'ggml-rpc-server',
  'llm-llamacpp',
  'model-fit',
  'ocr-ggml',
  'translation-nmtcpp',
  'tts-ggml',
  'turbovec-ggml',
  'vla-ggml',
]

// A prebuild counts as a pass when it actually succeeded or reused a cached
// artifact. A `skipped` prebuild is trusted ONLY when it was skipped for a
// legitimate reason: the ci-router job succeeded and decided not to build
// (run_prebuilds == 'false', i.e. no prebuild label). Any other skip is
// failure-induced - e.g. ci-router (which produces run_prebuilds) errored, so
// the gating condition fell through and the job never ran - and must fail
// closed rather than masquerade as a green prebuild. `reuse_hit` also skips the
// prebuild job (run_prebuilds == 'true', native unchanged) and is a real pass.
export function resolvePublishState(prebuildResult, reuseHit, ciRouterResult, runPrebuilds) {
  if (prebuildResult === 'success' || reuseHit === 'true') return 'success'
  if (prebuildResult === 'skipped') {
    if (ciRouterResult === 'success' && runPrebuilds === 'false') return 'success'
    return 'failure'
  }
  return 'failure'
}
