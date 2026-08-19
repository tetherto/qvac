import { fitLlamaConfig } from '../../index'
import type { FitReason, FitResult, LlamaLoadFitConfig } from '../../index'
import {
  encodeFitLlamaProcessRequest,
  FIT_PROCESS_PROTOCOL_VERSION_V2
} from '../../process'
import type { FitProcessRequest } from '../../process'

const config: LlamaLoadFitConfig = {
  modelPath: '/model.gguf',
  config: {
    device: 'gpu',
    'ctx-size': '4096',
    embedding: ''
  },
  marginMiB: 512,
  nCtxMin: 1024
}

const result: FitResult = fitLlamaConfig(config)
const requestLine: string = encodeFitLlamaProcessRequest(config)
const request: FitProcessRequest = {
  version: FIT_PROCESS_PROTOCOL_VERSION_V2,
  config
}
const reason: FitReason = 'unsupported-config'
void result
void requestLine
void request
void reason

// @ts-expect-error flat llama config values must be strings
fitLlamaConfig({ modelPath: '/model.gguf', config: { device: 1 } })

const lowLevelV2: FitProcessRequest = {
  version: FIT_PROCESS_PROTOCOL_VERSION_V2,
  // @ts-expect-error v2 carries LlamaLoadFitConfig, not low-level FitConfig
  config: { modelPath: '/model.gguf', nCtx: 4096 }
}
void lowLevelV2
