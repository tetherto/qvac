export const BUILTIN_PLUGINS: Record<string, { exportName: string }> = {
  "llamacpp-completion": { exportName: "llmPlugin" },
  "llamacpp-embedding": { exportName: "embeddingsPlugin" },
  "whispercpp-transcription": { exportName: "whisperPlugin" },
  "bci-whispercpp-transcription": { exportName: "bciPlugin" },
  "parakeet-transcription": { exportName: "parakeetPlugin" },
  "nmtcpp-translation": { exportName: "nmtPlugin" },
  "tts-ggml": { exportName: "ttsPlugin" },
  "ggml-ocr": { exportName: "ocrPlugin" },
  "sdcpp-generation": { exportName: "diffusionPlugin" },
  "ggml-vla": { exportName: "vlaPlugin" },
  "ggml-classification": { exportName: "classificationPlugin" },
};

export const BUILTIN_SUFFIXES = Object.keys(BUILTIN_PLUGINS);

export const DEFAULT_HOSTS = [
  "darwin-arm64",
  "darwin-x64",
  "linux-arm64",
  "linux-x64",
  "win32-x64",
  "android-arm64",
  "ios-arm64",
  "ios-arm64-simulator",
  "ios-x64-simulator",
];

export const DEFAULT_SDK_NAME = "@qvac/sdk";
