import { z } from 'zod'
import { perCallProfilingSchema } from './profiling.ts'
import { heartbeatRequestSchema, heartbeatResponseSchema } from './delegate.ts'
import {
  completionStreamRequestSchema,
  completionStreamResponseSchema
} from './completion-stream.ts'
import {
  batchCompletionStreamRequestSchema,
  batchCompletionStreamResponseSchema
} from './batch-completion-stream.ts'
import {
  loadModelRequestSchema,
  loadModelResponseSchema,
  modelProgressUpdateSchema
} from './load-model.ts'
import { downloadAssetRequestSchema, downloadAssetResponseSchema } from './download-asset.ts'
import {
  unloadModelRequestSchema,
  unloadModelResponseSchema,
  deleteCacheRequestSchema,
  deleteCacheResponseSchema
} from './model-ops.ts'
import {
  transcribeRequestSchema,
  transcribeResponseSchema,
  transcribeStreamRequestSchema,
  transcribeStreamResponseSchema
} from './transcription.ts'
import {
  bciTranscribeRequestSchema,
  bciTranscribeResponseSchema,
  bciTranscribeStreamRequestSchema,
  bciTranscribeStreamResponseSchema
} from './bci.ts'
import { embedRequestSchema, embedResponseSchema } from './embed.ts'
import { cancelRequestSchema, cancelResponseSchema } from './cancel.ts'
import {
  provideRequestSchema,
  provideResponseSchema,
  stopProvideRequestSchema,
  stopProvideResponseSchema
} from './provide.ts'
import { translateRequestSchema, translateResponseSchema } from './translate.ts'
import { loggingStreamRequestSchema, loggingStreamResponseSchema } from './logging-stream.ts'
import {
  ttsRequestSchema,
  ttsResponseSchema,
  textToSpeechStreamRequestSchema,
  textToSpeechStreamResponseSchema
} from './text-to-speech.ts'
import { errorResponseSchema } from './error.ts'
import { ragRequestSchema, ragResponseSchema, ragProgressUpdateSchema } from './rag.ts'
import {
  getModelInfoRequestSchema,
  getModelInfoResponseSchema,
  getLoadedModelInfoRequestSchema,
  getLoadedModelInfoResponseSchema
} from './model-info.ts'
import { ocrStreamRequestSchema, ocrStreamResponseSchema } from './ocr.ts'
import {
  diffusionStreamRequestSchema,
  diffusionStreamResponseSchema,
  videoStreamRequestSchema,
  videoStreamResponseSchema,
  upscaleStreamRequestSchema,
  upscaleStreamResponseSchema
} from './sdcpp-config.ts'
import {
  finetuneRequestSchema,
  finetuneResponseSchema,
  finetuneProgressResponseSchema
} from './finetune.ts'
import {
  pluginInvokeRequestSchema,
  pluginInvokeResponseSchema,
  pluginInvokeStreamRequestSchema,
  pluginInvokeStreamResponseSchema
} from './plugin.ts'
import {
  modelRegistryListRequestSchema,
  modelRegistryListResponseSchema,
  modelRegistrySearchRequestSchema,
  modelRegistrySearchResponseSchema,
  modelRegistryGetModelRequestSchema,
  modelRegistryGetModelResponseSchema
} from './registry.ts'
import {
  suspendRequestSchema,
  suspendResponseSchema,
  resumeRequestSchema,
  resumeResponseSchema,
  stateRequestSchema,
  stateResponseSchema
} from './lifecycle.ts'
import { classifyRequestSchema, classifyResponseSchema } from './classification.ts'

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
