import { z } from 'zod'
import { perCallProfilingSchema } from './profiling'
import { heartbeatRequestSchema, heartbeatResponseSchema } from './delegate'
import { completionStreamRequestSchema, completionStreamResponseSchema } from './completion-stream'
import {
  batchCompletionStreamRequestSchema,
  batchCompletionStreamResponseSchema
} from './batch-completion-stream'
import {
  loadModelRequestSchema,
  loadModelResponseSchema,
  modelProgressUpdateSchema
} from './load-model'
import { downloadAssetRequestSchema, downloadAssetResponseSchema } from './download-asset'
import {
  unloadModelRequestSchema,
  unloadModelResponseSchema,
  deleteCacheRequestSchema,
  deleteCacheResponseSchema
} from './model-ops'
import {
  transcribeRequestSchema,
  transcribeResponseSchema,
  transcribeStreamRequestSchema,
  transcribeStreamResponseSchema
} from './transcription'
import {
  bciTranscribeRequestSchema,
  bciTranscribeResponseSchema,
  bciTranscribeStreamRequestSchema,
  bciTranscribeStreamResponseSchema
} from './bci'
import { embedRequestSchema, embedResponseSchema } from './embed'
import { cancelRequestSchema, cancelResponseSchema } from './cancel'
import {
  provideRequestSchema,
  provideResponseSchema,
  stopProvideRequestSchema,
  stopProvideResponseSchema
} from './provide'
import { translateRequestSchema, translateResponseSchema } from './translate'
import { loggingStreamRequestSchema, loggingStreamResponseSchema } from './logging-stream'
import {
  ttsRequestSchema,
  ttsResponseSchema,
  textToSpeechStreamRequestSchema,
  textToSpeechStreamResponseSchema
} from './text-to-speech'
import { errorResponseSchema } from './error'
import { ragRequestSchema, ragResponseSchema, ragProgressUpdateSchema } from './rag'
import {
  getModelInfoRequestSchema,
  getModelInfoResponseSchema,
  getLoadedModelInfoRequestSchema,
  getLoadedModelInfoResponseSchema
} from './model-info'
import { ocrStreamRequestSchema, ocrStreamResponseSchema } from './ocr'
import {
  diffusionStreamRequestSchema,
  diffusionStreamResponseSchema,
  videoStreamRequestSchema,
  videoStreamResponseSchema,
  upscaleStreamRequestSchema,
  upscaleStreamResponseSchema
} from './sdcpp-config'
import {
  finetuneRequestSchema,
  finetuneResponseSchema,
  finetuneProgressResponseSchema
} from './finetune'
import {
  pluginInvokeRequestSchema,
  pluginInvokeResponseSchema,
  pluginInvokeStreamRequestSchema,
  pluginInvokeStreamResponseSchema
} from './plugin'
import {
  modelRegistryListRequestSchema,
  modelRegistryListResponseSchema,
  modelRegistrySearchRequestSchema,
  modelRegistrySearchResponseSchema,
  modelRegistryGetModelRequestSchema,
  modelRegistryGetModelResponseSchema
} from './registry'
import {
  suspendRequestSchema,
  suspendResponseSchema,
  resumeRequestSchema,
  resumeResponseSchema,
  stateRequestSchema,
  stateResponseSchema
} from './lifecycle'
import { classifyRequestSchema, classifyResponseSchema } from './classification'

export const requestSchema = z.union([
  heartbeatRequestSchema,
  loadModelRequestSchema,
  downloadAssetRequestSchema,
  completionStreamRequestSchema,
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
  provideRequestSchema,
  stopProvideRequestSchema,
  ragRequestSchema,
  deleteCacheRequestSchema,
  getModelInfoRequestSchema,
  getLoadedModelInfoRequestSchema,
  ocrStreamRequestSchema,
  diffusionStreamRequestSchema,
  videoStreamRequestSchema,
  upscaleStreamRequestSchema,
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
  heartbeatResponseSchema,
  loadModelResponseSchema,
  downloadAssetResponseSchema,
  completionStreamResponseSchema,
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
  provideResponseSchema,
  stopProvideResponseSchema,
  errorResponseSchema,
  ragResponseSchema,
  ragProgressUpdateSchema,
  deleteCacheResponseSchema,
  getModelInfoResponseSchema,
  getLoadedModelInfoResponseSchema,
  ocrStreamResponseSchema,
  diffusionStreamResponseSchema,
  videoStreamResponseSchema,
  upscaleStreamResponseSchema,
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

export const rpcOptionsSchema = z.object({
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
