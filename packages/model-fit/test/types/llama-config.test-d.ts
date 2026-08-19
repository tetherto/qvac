import type { FitReason } from '../../index'
import {
  encodeFitLlamaProcessRequest,
  FIT_PROCESS_PROTOCOL_VERSION_V2
} from '../../process'
import type {
  FitLlamaProcessConfig,
  FitProcessRequest,
  LlamaLoadKind
} from '../../process'

const loadKind: LlamaLoadKind = 'embedding'
const config: FitLlamaProcessConfig = {
  modelPath: '/model.gguf',
  params: {
    device: 'gpu',
    'ctx-size': '4096'
  },
  marginMiB: 512,
  nCtxMin: 1024
}

const requestLine: string = encodeFitLlamaProcessRequest(loadKind, config)
const request: FitProcessRequest = {
  version: FIT_PROCESS_PROTOCOL_VERSION_V2,
  loadKind,
  config
}
const reason: FitReason = 'unsupported-config'
void requestLine
void request
void reason

// @ts-expect-error load kind must be neutral completion or embedding
encodeFitLlamaProcessRequest('llm', config)

// @ts-expect-error flat llama params values must be strings
encodeFitLlamaProcessRequest('completion', { modelPath: '/model.gguf', params: { device: 1 } })

const lowLevelV2: FitProcessRequest = {
  version: FIT_PROCESS_PROTOCOL_VERSION_V2,
  loadKind: 'completion',
  // @ts-expect-error v2 carries FitLlamaProcessConfig, not low-level FitConfig
  config: { modelPath: '/model.gguf', nCtx: 4096 }
}
void lowLevelV2
