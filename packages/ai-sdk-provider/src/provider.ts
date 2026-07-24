import { createOpenAICompatible } from '@ai-sdk/openai-compatible'
import type { ProviderV4 } from '@ai-sdk/provider'
import { customProvider } from 'ai'

import { createQvacSpeechModel, createQvacTranscriptionModel } from './audio-models.js'
import { DEFAULT_API_KEY, DEFAULT_BASE_URL, DEFAULT_HEADERS } from './defaults.js'
import { createQvacFiles } from './files.js'
import { withQvacFileReferences } from './file-reference-model.js'
import { mergeHeaders } from './headers.js'
import type {
  ManagedQvacProvider,
  QvacExternalOptions,
  QvacManagedOptions,
  QvacOptions,
  QvacProvider
} from './types.js'

// External mode synchronously composes the OpenAI-compatible language-model
// surface with QVAC's native files, transcription, and speech capabilities.
// Language models also resolve QVAC file references through the caller-managed
// `qvac serve openai` endpoint.
export function createExternalQvac(options: QvacExternalOptions = {}): QvacProvider {
  const apiKey = options.apiKey ?? DEFAULT_API_KEY
  const headers = mergeHeaders(DEFAULT_HEADERS, options.headers)
  if (apiKey && headers['authorization'] === undefined) {
    headers['authorization'] = `Bearer ${apiKey}`
  }
  const baseURL = options.baseURL ?? DEFAULT_BASE_URL
  const init: Parameters<typeof createOpenAICompatible>[0] = {
    name: 'qvac',
    baseURL,
    headers
  }
  if (options.fetch !== undefined) init.fetch = options.fetch
  const compatible = createOpenAICompatible(init)
  const localOptions = {
    baseURL,
    headers,
    ...(options.fetch !== undefined && { fetch: options.fetch })
  }
  const wrap = (model: ReturnType<typeof compatible.chatModel>) =>
    withQvacFileReferences(model, localOptions)

  // QVAC's HTTP transport remains OpenAI-compatible. `customProvider` composes
  // the additional native capability contracts over that fallback instead of
  // replacing or forking the compatible language/embedding/image behavior.
  const compatibleFallback: ProviderV4 = {
    specificationVersion: 'v4',
    languageModel: (modelId) => wrap(compatible.languageModel(modelId)),
    embeddingModel: (modelId) => compatible.embeddingModel(modelId),
    imageModel: (modelId) => compatible.imageModel(modelId),
    transcriptionModel: (modelId) => createQvacTranscriptionModel(modelId, localOptions),
    speechModel: (modelId) => createQvacSpeechModel(modelId, localOptions)
  }
  const composed = customProvider({
    files: createQvacFiles(localOptions),
    fallbackProvider: compatibleFallback
  })

  const provider = ((modelId: string) => composed.languageModel(modelId)) as QvacProvider
  Object.assign(provider, compatible)
  Object.defineProperty(provider, 'specificationVersion', {
    value: composed.specificationVersion,
    enumerable: true
  })
  provider.languageModel = (modelId: string) => composed.languageModel(modelId)
  provider.chatModel = (modelId: string) => composed.languageModel(modelId)
  provider.embeddingModel = (modelId: string) => composed.embeddingModel(modelId)
  provider.textEmbeddingModel = (modelId: string) => composed.embeddingModel(modelId)
  provider.imageModel = (modelId: string) => composed.imageModel(modelId)
  provider.transcriptionModel = (modelId: string) => composed.transcriptionModel(modelId)
  provider.speechModel = (modelId: string) => composed.speechModel(modelId)
  provider.files = () => composed.files()
  return provider
}

export function createQvac(options?: QvacExternalOptions): QvacProvider
export function createQvac(options: QvacManagedOptions): Promise<ManagedQvacProvider>
export function createQvac(options: QvacOptions = {}): QvacProvider | Promise<ManagedQvacProvider> {
  if (options.mode === 'managed') {
    // Lazy import keeps the supervisor (and its `node:child_process` /
    // `node:net` / `@qvac/cli` resolution) out of the module graph for the
    // common external-mode path, so those users pay no startup or install cost.
    return import('./managed/index.js').then((m) => m.startManagedQvac(options))
  }
  return createExternalQvac(options)
}

export const qvac: QvacProvider = createQvac()
