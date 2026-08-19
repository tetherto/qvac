import {
  encodeFitLlamaProcessRequest,
  encodeFitProcessRequest,
  parseFitProcessResponse,
  resolveFitProcessRunnerPath,
  FIT_PROCESS_PROTOCOL_VERSION,
  FIT_PROCESS_PROTOCOL_VERSION_V2,
  FIT_PROCESS_MAX_REQUEST_BYTES,
  FIT_PROCESS_MAX_RESPONSE_BYTES
} from '../../process'
import type {
  FitLlamaProcessConfig,
  FitProcessRequest,
  FitProcessResponse
} from '../../process'
import type { FitConfig, FitResult } from '../../index'

declare function assertNever (value: never): never

const v1Config: FitConfig = { modelPath: '/model.gguf', nCtx: 4096, swaFull: true }
const v2Config: FitLlamaProcessConfig = {
  modelPath: '/model.gguf',
  params: { device: 'gpu', 'ctx-size': '4096' }
}
const v1Line: string = encodeFitProcessRequest(v1Config)
const v2Line: string = encodeFitLlamaProcessRequest('completion', v2Config)
const runnerPath: string = resolveFitProcessRunnerPath()
void v1Line
void v2Line
void runnerPath

const v1Request: FitProcessRequest = {
  version: FIT_PROCESS_PROTOCOL_VERSION,
  config: v1Config
}
const v2Request: FitProcessRequest = {
  version: FIT_PROCESS_PROTOCOL_VERSION_V2,
  loadKind: 'completion',
  config: v2Config
}
void v1Request
void v2Request

const response: FitProcessResponse = parseFitProcessResponse(null as unknown)
if (response.status === 'completed') {
  const result: FitResult = response.result
  void result
} else {
  const name: string = response.error.name
  void name
}

function describe (value: FitProcessResponse): string {
  switch (value.status) {
    case 'completed': return value.result.reason
    case 'invocation-error': return value.error.message
    default: return assertNever(value)
  }
}
void describe

if (response.version === FIT_PROCESS_PROTOCOL_VERSION_V2) {
  const version: 2 = response.version
  void version
} else {
  const version: 1 = response.version
  void version
}

// @ts-expect-error v2 accepts raw llama config only
const invalidV2: FitProcessRequest = {
  version: FIT_PROCESS_PROTOCOL_VERSION_V2,
  config: v1Config
}
void invalidV2

// @ts-expect-error version 3 is unsupported
const stale: FitProcessRequest = { version: 3, config: v1Config }
void stale

const maxRequest: number = FIT_PROCESS_MAX_REQUEST_BYTES
const maxResponse: number = FIT_PROCESS_MAX_RESPONSE_BYTES
void maxRequest
void maxResponse
