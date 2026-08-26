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
import { audioGenStreamRequestSchema, audioGenStreamResponseSchema } from '@/schemas/audio-gen'

export const requestSchema = z.union([
  audioGenStreamRequestSchema,
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
  deleteCacheRequestSchema,
  getModelInfoRequestSchema,
  getLoadedModelInfoRequestSchema,
  getSystemResourcesRequestSchema,
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
  deleteCacheResponseSchema,
  getModelInfoResponseSchema,
  getLoadedModelInfoResponseSchema,
  getSystemResourcesResponseSchema,
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
