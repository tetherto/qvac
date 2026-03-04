/**
 * Built-in plugin registry mapping suffix to export name.
 * Specifier format: `${sdkName}/${suffix}/plugin`
 */
export const BUILTIN_PLUGINS = {
  'llamacpp-completion': { exportName: 'llmPlugin' },
  'llamacpp-embedding': { exportName: 'embeddingsPlugin' },
  'whispercpp-transcription': { exportName: 'whisperPlugin' },
  'nmtcpp-translation': { exportName: 'nmtPlugin' },
  'onnx-tts': { exportName: 'ttsPlugin' },
  'onnx-ocr': { exportName: 'ocrPlugin' }
}

export const BUILTIN_SUFFIXES = Object.keys(BUILTIN_PLUGINS)

/** Supported bare-pack host targets */
export const DEFAULT_HOSTS = [
  'darwin-arm64',
  'darwin-x64',
  'linux-arm64',
  'linux-x64',
  'win32-x64',
  'android-arm64',
  'ios-arm64',
  'ios-arm64-simulator',
  'ios-x64-simulator'
]

export const DEFAULT_SDK_NAME = '@qvac/sdk'
