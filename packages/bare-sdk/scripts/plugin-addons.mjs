/**
 * Canonical list of @qvac/* plugin addon packages. Shared by
 * check-no-addon-deps.mjs, check-no-addon-leaks.mjs, and
 * check-deps-vs-sdk.mjs.
 */
export const PLUGIN_ADDONS = new Set([
  "@qvac/llm-llamacpp",
  "@qvac/embed-llamacpp",
  "@qvac/transcription-whispercpp",
  "@qvac/bci-whispercpp",
  "@qvac/transcription-parakeet",
  "@qvac/translation-nmtcpp",
  "@qvac/tts-ggml",
  "@qvac/ocr-ggml",
  "@qvac/diffusion-cpp",
  "@qvac/vla-ggml",
  "@qvac/classification-ggml",
]);
