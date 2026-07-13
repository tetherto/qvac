// Ambient declarations for the Bare-only worker build (tsconfig.worker.json).
//
// The worker imports @qvac/core's Bare subpaths, which resolve to core's `.ts`.
// Under Node types those sources fail to compile, so the worker transpile build
// must not follow them. Declaring each subpath as an exact ambient module
// short-circuits resolution: `tsc` transpiles the worker's own files without
// loading core. Bare resolves the real package exports at runtime and strips
// the types.

declare module '@qvac/core/engine' {
  export const send: any
  export const stream: any
  export const duplex: any
  export const dispatchTransport: any
  export const setConfig: any
  export const setRuntimeContext: any
  export const initialize: any
  export const cleanupForTerminate: any
  export const close: any
}

declare module '@qvac/core/plugins' {
  export const registerPlugins: any
}

declare module '@qvac/core/llamacpp-completion/plugin' {
  export const llmPlugin: any
}
declare module '@qvac/core/llamacpp-embedding/plugin' {
  export const embeddingsPlugin: any
}
declare module '@qvac/core/whispercpp-transcription/plugin' {
  export const whisperPlugin: any
}
declare module '@qvac/core/bci-whispercpp-transcription/plugin' {
  export const bciPlugin: any
}
declare module '@qvac/core/parakeet-transcription/plugin' {
  export const parakeetPlugin: any
}
declare module '@qvac/core/nmtcpp-translation/plugin' {
  export const nmtPlugin: any
}
declare module '@qvac/core/tts-ggml/plugin' {
  export const ttsPlugin: any
}
declare module '@qvac/core/ggml-ocr/plugin' {
  export const ocrPlugin: any
}
declare module '@qvac/core/sdcpp-generation/plugin' {
  export const diffusionPlugin: any
}
declare module '@qvac/core/ggml-vla/plugin' {
  export const vlaPlugin: any
}
declare module '@qvac/core/ggml-classification/plugin' {
  export const classificationPlugin: any
}
