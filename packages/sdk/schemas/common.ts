import { z } from "zod";
import { perCallProfilingSchema } from "./profiling";
import { heartbeatRequestSchema, heartbeatResponseSchema } from "./heartbeat";
import {
  completionStreamRequestSchema,
  completionStreamResponseSchema,
} from "./completion-stream";
import {
  loadModelRequestSchema,
  loadModelResponseSchema,
  modelProgressUpdateSchema,
} from "./load-model";
import {
  downloadAssetRequestSchema,
  downloadAssetResponseSchema,
} from "./download-asset";
import {
  unloadModelRequestSchema,
  unloadModelResponseSchema,
} from "./unload-model";
import {
  transcribeRequestSchema,
  transcribeResponseSchema,
  transcribeStreamRequestSchema,
  transcribeStreamResponseSchema,
} from "./transcription";
import { embedRequestSchema, embedResponseSchema } from "./embed";
import { cancelRequestSchema, cancelResponseSchema } from "./cancel";
import { provideRequestSchema, provideResponseSchema } from "./provide";
import {
  stopProvideRequestSchema,
  stopProvideResponseSchema,
} from "./stop-provide";
import { translateRequestSchema, translateResponseSchema } from "./translate";
import {
  loggingStreamRequestSchema,
  loggingStreamResponseSchema,
} from "./logging-stream";
import { ttsRequestSchema, ttsResponseSchema } from "./text-to-speech";
import { errorResponseSchema } from "./error";
import {
  ragRequestSchema,
  ragResponseSchema,
  ragProgressUpdateSchema,
} from "./rag";
import {
  deleteCacheRequestSchema,
  deleteCacheResponseSchema,
} from "./delete-cache";
import {
  getModelInfoRequestSchema,
  getModelInfoResponseSchema,
} from "./get-model-info";
import { ocrStreamRequestSchema, ocrStreamResponseSchema } from "./ocr";
import {
  diffusionStreamRequestSchema,
  diffusionStreamResponseSchema,
} from "./sdcpp-config";
import {
  finetuneRequestSchema,
  finetuneResponseSchema,
  finetuneProgressResponseSchema,
} from "./finetune";
import {
  pluginInvokeRequestSchema,
  pluginInvokeResponseSchema,
  pluginInvokeStreamRequestSchema,
  pluginInvokeStreamResponseSchema,
} from "./plugin";
import {
  modelRegistryListRequestSchema,
  modelRegistryListResponseSchema,
  modelRegistrySearchRequestSchema,
  modelRegistrySearchResponseSchema,
  modelRegistryGetModelRequestSchema,
  modelRegistryGetModelResponseSchema,
} from "./registry";
import { suspendRequestSchema, suspendResponseSchema } from "./suspend";
import { resumeRequestSchema, resumeResponseSchema } from "./resume";

export const requestSchema = z.union([
  heartbeatRequestSchema,
  loadModelRequestSchema,
  downloadAssetRequestSchema,
  completionStreamRequestSchema,
  unloadModelRequestSchema,
  transcribeRequestSchema,
  transcribeStreamRequestSchema,
  loggingStreamRequestSchema,
  embedRequestSchema,
  translateRequestSchema,
  ttsRequestSchema,
  cancelRequestSchema,
  provideRequestSchema,
  stopProvideRequestSchema,
  ragRequestSchema,
  deleteCacheRequestSchema,
  getModelInfoRequestSchema,
  ocrStreamRequestSchema,
  diffusionStreamRequestSchema,
  finetuneRequestSchema,
  pluginInvokeRequestSchema,
  pluginInvokeStreamRequestSchema,
  modelRegistryListRequestSchema,
  modelRegistrySearchRequestSchema,
  modelRegistryGetModelRequestSchema,
  suspendRequestSchema,
  resumeRequestSchema,
]);

export const responseSchema = z.discriminatedUnion("type", [
  heartbeatResponseSchema,
  loadModelResponseSchema,
  downloadAssetResponseSchema,
  completionStreamResponseSchema,
  unloadModelResponseSchema,
  modelProgressUpdateSchema,
  transcribeResponseSchema,
  transcribeStreamResponseSchema,
  loggingStreamResponseSchema,
  embedResponseSchema,
  translateResponseSchema,
  ttsResponseSchema,
  cancelResponseSchema,
  provideResponseSchema,
  stopProvideResponseSchema,
  errorResponseSchema,
  ragResponseSchema,
  ragProgressUpdateSchema,
  deleteCacheResponseSchema,
  getModelInfoResponseSchema,
  ocrStreamResponseSchema,
  diffusionStreamResponseSchema,
  finetuneResponseSchema,
  finetuneProgressResponseSchema,
  pluginInvokeResponseSchema,
  pluginInvokeStreamResponseSchema,
  modelRegistryListResponseSchema,
  modelRegistrySearchResponseSchema,
  modelRegistryGetModelResponseSchema,
  suspendResponseSchema,
  resumeResponseSchema,
]);

export const rpcOptionsSchema = z.object({
  timeout: z.number().min(100).optional(),
  healthCheckTimeout: z.number().min(100).optional(),
  forceNewConnection: z.boolean().optional(),
  profiling: perCallProfilingSchema.optional(),
});

export type Request = z.infer<typeof requestSchema>;
export type Response = z.infer<typeof responseSchema>;
export type RPCOptions = z.infer<typeof rpcOptionsSchema>;
