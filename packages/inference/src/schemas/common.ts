import {
  startRpcServerRequestSchema,
  startRpcServerResponseSchema,
  stopRpcServerRequestSchema,
  stopRpcServerResponseSchema,
  discoverRpcServersRequestSchema,
  discoverRpcServersResponseSchema
} from '@/schemas/rpc-server'
import { z } from 'zod'
import { perCallProfilingSchema } from '@/schemas/profiling'
import { heartbeatRequestSchema, heartbeatResponseSchema } from '@/schemas/heartbeat'
import {
  completionOrchestrateRequestSchema,
  completionOrchestrateResponseSchema,
  completionStreamRequestSchema,
  completionStreamResponseSchema
} from '@/schemas/completion-stream'
import {
  batchCompletionStreamRequestSchema,
  batchCompletionStreamResponseSchema
} from '@/schemas/batch-completion-stream'
import {
  loadModelRequestSchema,
  loadModelResponseSchema,
  modelProgressUpdateSchema
} from '@/schemas/load-model'
import { downloadAssetRequestSchema, downloadAssetResponseSchema } from '@/schemas/download-asset'
import {
  unloadModelRequestSchema,
  unloadModelResponseSchema,
  deleteCacheRequestSchema,
  deleteCacheResponseSchema
} from '@/schemas/model-ops'
import {
  transcribeRequestSchema,
  transcribeResponseSchema,
  transcribeStreamRequestSchema,
  transcribeStreamResponseSchema
} from '@/schemas/transcription'
import {
  bciTranscribeRequestSchema,
  bciTranscribeResponseSchema,
  bciTranscribeStreamRequestSchema,
  bciTranscribeStreamResponseSchema
} from '@/schemas/bci'
import { embedRequestSchema, embedResponseSchema } from '@/schemas/embed'
import { cancelRequestSchema, cancelResponseSchema } from '@/schemas/cancel'
import { translateRequestSchema, translateResponseSchema } from '@/schemas/translate'
import { loggingStreamRequestSchema, loggingStreamResponseSchema } from '@/schemas/logging-stream'
import {
  ttsRequestSchema,
  ttsResponseSchema,
  textToSpeechStreamRequestSchema,
  textToSpeechStreamResponseSchema
} from '@/schemas/text-to-speech'
import { errorResponseSchema } from '@/schemas/error'
import { ragRequestSchema, ragResponseSchema, ragProgressUpdateSchema } from '@/schemas/rag'
import { vectorIndexRequestSchema, vectorIndexResponseSchema } from '@/schemas/vector-index'
import {
  getModelInfoRequestSchema,
  getModelInfoResponseSchema,
  getLoadedModelInfoRequestSchema,
  getLoadedModelInfoResponseSchema
} from '@/schemas/model-info'
import {
  getSystemResourcesRequestSchema,
  getSystemResourcesResponseSchema
} from '@/schemas/system-resources'
import {
  assessModelFitRequestSchema,
  assessModelFitResponseSchema
} from '@/schemas/assess-model-fit'
import { ocrStreamRequestSchema, ocrStreamResponseSchema } from '@/schemas/ocr'
import {
  diffusionStreamRequestSchema,
  diffusionStreamResponseSchema,
  videoStreamRequestSchema,
  videoStreamResponseSchema,
  upscaleStreamRequestSchema,
  upscaleStreamResponseSchema,
  worldSceneStreamRequestSchema,
  worldSceneStreamResponseSchema,
  worldStepStreamRequestSchema,
  worldStepStreamResponseSchema
} from '@/schemas/sdcpp-config'
import {
  finetuneRequestSchema,
  finetuneResponseSchema,
  finetuneProgressResponseSchema
} from '@/schemas/finetune'
import {
  pluginInvokeRequestSchema,
  pluginInvokeResponseSchema,
  pluginInvokeStreamRequestSchema,
  pluginInvokeStreamResponseSchema
} from '@/schemas/plugin'
import {
  modelRegistryListRequestSchema,
  modelRegistryListResponseSchema,
  modelRegistrySearchRequestSchema,
  modelRegistrySearchResponseSchema,
  modelRegistryGetModelRequestSchema,
  modelRegistryGetModelResponseSchema
} from '@/schemas/registry'
import {
  suspendRequestSchema,
  suspendResponseSchema,
  resumeRequestSchema,
  resumeResponseSchema,
  stateRequestSchema,
  stateResponseSchema
} from '@/schemas/lifecycle'
import { classifyRequestSchema, classifyResponseSchema } from '@/schemas/classification'
import {
  audioEditStreamRequestSchema,
  audioEditStreamResponseSchema,
  audioGenStreamRequestSchema,
  audioGenStreamResponseSchema,
  audioUnderstandRequestSchema,
  audioUnderstandResponseSchema
} from '@/schemas/audio-gen'

export const requestSchema = z.union([
  audioGenStreamRequestSchema,
  audioEditStreamRequestSchema,
  audioUnderstandRequestSchema,
  startRpcServerRequestSchema,
  stopRpcServerRequestSchema,
  discoverRpcServersRequestSchema,
  heartbeatRequestSchema,
  loadModelRequestSchema,
  downloadAssetRequestSchema,
  completionStreamRequestSchema,
  completionOrchestrateRequestSchema,
  batchCompletionStreamRequestSchema,
  unloadModelRequestSchema,
  transcribeRequestSchema,
  transcribeStreamRequestSchema,
  bciTranscribeRequestSchema,
  bciTranscribeStreamRequestSchema,
  loggingStreamRequestSchema,
  embedRequestSchema,
  translateRequestSchema,
  ttsRequestSchema,
  textToSpeechStreamRequestSchema,
  cancelRequestSchema,
  ragRequestSchema,
  vectorIndexRequestSchema,
  deleteCacheRequestSchema,
  getModelInfoRequestSchema,
  getLoadedModelInfoRequestSchema,
  getSystemResourcesRequestSchema,
  assessModelFitRequestSchema,
  ocrStreamRequestSchema,
  diffusionStreamRequestSchema,
  videoStreamRequestSchema,
  upscaleStreamRequestSchema,
  worldSceneStreamRequestSchema,
  worldStepStreamRequestSchema,
  finetuneRequestSchema,
  pluginInvokeRequestSchema,
  pluginInvokeStreamRequestSchema,
  modelRegistryListRequestSchema,
  modelRegistrySearchRequestSchema,
  modelRegistryGetModelRequestSchema,
  suspendRequestSchema,
  resumeRequestSchema,
  stateRequestSchema,
  classifyRequestSchema
])

export const responseSchema = z.discriminatedUnion('type', [
  audioGenStreamResponseSchema,
  audioEditStreamResponseSchema,
  audioUnderstandResponseSchema,
  startRpcServerResponseSchema,
  stopRpcServerResponseSchema,
  discoverRpcServersResponseSchema,
  heartbeatResponseSchema,
  loadModelResponseSchema,
  downloadAssetResponseSchema,
  completionStreamResponseSchema,
  completionOrchestrateResponseSchema,
  batchCompletionStreamResponseSchema,
  unloadModelResponseSchema,
  modelProgressUpdateSchema,
  transcribeResponseSchema,
  transcribeStreamResponseSchema,
  bciTranscribeResponseSchema,
  bciTranscribeStreamResponseSchema,
  loggingStreamResponseSchema,
  embedResponseSchema,
  translateResponseSchema,
  ttsResponseSchema,
  textToSpeechStreamResponseSchema,
  cancelResponseSchema,
  errorResponseSchema,
  ragResponseSchema,
  ragProgressUpdateSchema,
  vectorIndexResponseSchema,
  deleteCacheResponseSchema,
  getModelInfoResponseSchema,
  getLoadedModelInfoResponseSchema,
  getSystemResourcesResponseSchema,
  assessModelFitResponseSchema,
  ocrStreamResponseSchema,
  diffusionStreamResponseSchema,
  videoStreamResponseSchema,
  upscaleStreamResponseSchema,
  worldSceneStreamResponseSchema,
  worldStepStreamResponseSchema,
  finetuneResponseSchema,
  finetuneProgressResponseSchema,
  pluginInvokeResponseSchema,
  pluginInvokeStreamResponseSchema,
  modelRegistryListResponseSchema,
  modelRegistrySearchResponseSchema,
  modelRegistryGetModelResponseSchema,
  suspendResponseSchema,
  resumeResponseSchema,
  stateResponseSchema,
  classifyResponseSchema
])

/**
 * The part of an `AbortSignal` that a call reads. Structural, so the signal of
 * every runtime fits: the global one on Node, Electron and React Native, and
 * `bare-abort-controller`'s on Bare.
 */
export interface AbortSignalLike {
  readonly aborted: boolean
  readonly reason?: unknown
  addEventListener(type: 'abort', listener: () => void, options?: { once?: boolean }): void
  removeEventListener(type: 'abort', listener: () => void): void
}

function isAbortSignalLike(value: unknown): value is AbortSignalLike {
  if (typeof value !== 'object' || value === null) return false
  const signal = value as Partial<AbortSignalLike>
  return (
    typeof signal.aborted === 'boolean' &&
    typeof signal.addEventListener === 'function' &&
    typeof signal.removeEventListener === 'function'
  )
}

export const rpcOptionsSchema = z.object({
  signal: z
    .custom<AbortSignalLike>(isAbortSignalLike, 'Expected an AbortSignal')
    .optional()
    .describe(
      'Ends a streaming call when aborted: the stream finishes without an error and the worker releases what it held for it. Single-reply calls ignore it.'
    ),
  timeout: z
    .number()
    .min(100)
    .optional()
    .describe('Per-call RPC timeout in milliseconds; overrides the default for this request only.'),
  healthCheckTimeout: z
    .number()
    .min(100)
    .optional()
    .describe('Timeout in milliseconds for the health-check probe that precedes the RPC call.'),
  forceNewConnection: z
    .boolean()
    .optional()
    .describe('When `true`, skip any cached RPC connection and open a fresh one for this call.'),
  profiling: perCallProfilingSchema
    .optional()
    .describe(
      'Per-call profiler configuration; when present, overrides the global profiler settings for this request.'
    )
})

export type Request = z.input<typeof requestSchema>
export type Response = z.infer<typeof responseSchema>
export type RPCOptions = z.infer<typeof rpcOptionsSchema>
