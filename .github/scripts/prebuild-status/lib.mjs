// Packages whose pr-build-test.yml status job checks a prebuild.

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

// Packages with C++/fuzz suites. audiogen-ggml's suite is a config-parse fuzz target, with no prebuild.
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
