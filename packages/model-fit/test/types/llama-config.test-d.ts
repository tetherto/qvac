import type { FitReason, FitResult } from '../../index'
import {
  encodeFitLlamaProcessRequest,
  FIT_PROCESS_PROTOCOL_VERSION_V2
} from '../../process'
import type {
  FitLlamaProcessConfig,
  FitLlamaReason,
  FitLlamaResult,
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
const reason: FitLlamaReason = 'unsupported-config'
void requestLine
void request
void reason

// A v1 reason is still a valid llama-load reason — the v2 type widens the v1
// contract rather than replacing it.
const shared: FitLlamaReason = 'no-backend-device'
void shared

// ...and every FitResult is a valid FitLlamaResult, so a consumer that already
// handles the low-level outcomes needs no rewrite to read a v2 result.
declare const lowLevel: FitResult
const widened: FitLlamaResult = lowLevel
void widened

// @ts-expect-error the v2-only reason is not part of the fitParams contract
const narrowed: FitReason = 'unsupported-config'
void narrowed

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
