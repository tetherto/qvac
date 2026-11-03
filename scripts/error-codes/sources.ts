import type { CodeSource } from './check.js'

export const sources: readonly CodeSource[] = [
  {
    owner: '@qvac/error',
    file: 'packages/error/src/index.ts',
    symbols: ['ERR_CODES']
  },
  {
    owner: '@qvac/asr-ggml',
    file: 'packages/asr-ggml/src/lib/error.ts',
    symbols: ['ERR_CODES', 'ERR_CODES_PARAKEET']
  },
  {
    owner: '@qvac/translation-nmtcpp',
    file: 'packages/translation-nmtcpp/src/lib/error.ts',
    symbols: ['ERR_CODES']
  },
  {
    owner: '@qvac/ocr-ggml',
    file: 'packages/ocr-ggml/src/lib/error.ts',
    symbols: ['ERR_CODES']
  },
  {
    owner: '@qvac/decoder-audio',
    file: 'packages/decoder-audio/src/utils/error.ts',
    symbols: ['ERR_CODES']
  },
  {
    owner: '@qvac/tts-ggml',
    file: 'packages/tts-ggml/src/lib/error.ts',
    symbols: ['ERR_CODES']
  },
  {
    owner: '@qvac/rag',
    file: 'packages/rag/src/errors.ts',
    symbols: ['ERR_CODES']
  },
  {
    owner: '@qvac/registry-client',
    file: 'packages/registry-server/client/utils/error.js',
    symbols: ['ERR_CODES']
  },
  {
    owner: '@qvac/bci-whispercpp',
    file: 'packages/bci-whispercpp/src/lib/error.ts',
    symbols: ['ERR_CODES']
  },
  {
    owner: '@qvac/vla-ggml',
    file: 'packages/vla-ggml/src/lib/error.ts',
    symbols: ['ERR_CODES']
  },
  {
    owner: '@qvac/audiogen-ggml',
    file: 'packages/audiogen-ggml/src/error.ts',
    symbols: ['ERR_CODES']
  },
  {
    owner: '@qvac/sdk',
    file: 'packages/sdk/src/schemas/sdk-errors-client.ts',
    symbols: ['SDK_CLIENT_ERROR_CODES']
  },
  {
    owner: '@qvac/sdk',
    file: 'packages/sdk/src/schemas/sdk-errors-server.ts',
    symbols: ['SDK_SERVER_ERROR_CODES']
  },
  {
    owner: '@qvac/inference',
    file: 'packages/inference/src/schemas/errors.ts',
    symbols: ['ERROR_CODES', 'REGISTRY_ERROR_CODES']
  }
]
