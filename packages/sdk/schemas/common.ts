import { z } from "zod";
import { pingRequestSchema, pingResponseSchema } from "./ping";
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

export const requestSchema = z.union([
  pingRequestSchema,
  loadModelRequestSchema,
  downloadAssetRequestSchema,
  completionStreamRequestSchema,
  unloadModelRequestSchema,
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
]);

export const responseSchema = z.discriminatedUnion("type", [
  pingResponseSchema,
  loadModelResponseSchema,
  downloadAssetResponseSchema,
  completionStreamResponseSchema,
  unloadModelResponseSchema,
  modelProgressUpdateSchema,
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
]);

export const rpcOptionsSchema = z.object({
  timeout: z.number().min(100).optional(),
  forceNewConnection: z.boolean().optional(),
});

export type Request = z.infer<typeof requestSchema>;
export type Response = z.infer<typeof responseSchema>;
export type RPCOptions = z.infer<typeof rpcOptionsSchema>;
