import { type Request } from "@/schemas";
import { handleCompletionStream } from "@/server/rpc/handlers/completion-stream";
import { handleDownloadAsset } from "@/server/rpc/handlers/download-asset";
import { handleLoadModel } from "@/server/rpc/handlers/load-model";
import { handleLoadModelDelegated } from "@/server/rpc/handlers/load-model-delegated";
import { handleCompletionStreamDelegated } from "@/server/rpc/handlers/completion-stream-delegated";
import { getModelEntry } from "@/server/bare/registry/model-registry";
import { handleUnloadModel } from "@/server/rpc/handlers/unload-model";
import { handleUnloadModelDelegated } from "@/server/rpc/handlers/unload-model-delegated";
import { handleTranscribe } from "@/server/rpc/handlers/transcribe";
import { handleTranscribeStream } from "@/server/rpc/handlers/transcribe-stream";
import { handleEmbed } from "@/server/rpc/handlers/embed";
import { handleTranslate } from "@/server/rpc/handlers/translate";
import { handleLoggingStream } from "@/server/rpc/handlers/logging-stream";
import { cancelHandler } from "./handlers/cancelHandler";
import { provideHandler } from "./handlers/provideHandler";
import { stopProvideHandler } from "./handlers/stopProvideHandler";
import { handleRag } from "@/server/rpc/handlers/rag";
import { handleDeleteCache } from "@/server/rpc/handlers/delete-cache";
import { handleTextToSpeech } from "@/server/rpc/handlers/text-to-speech";
import { handleGetModelInfo } from "@/server/rpc/handlers/get-model-info";
import { handleOCRStream } from "@/server/rpc/handlers/ocr-stream";
import { handleHeartbeat } from "@/server/rpc/handlers/heartbeat";
import { handleFinetune } from "@/server/rpc/handlers/finetune";
import { handleHeartbeatDelegated } from "@/server/rpc/handlers/heartbeat-delegated";
import { handleCancelDelegated } from "@/server/rpc/handlers/cancel-delegated";
import { handleDiffusionStream } from "@/server/rpc/handlers/diffusion-stream";
import {
  handlePluginInvoke,
  handlePluginInvokeStream,
} from "@/server/rpc/handlers/plugin-invoke";
import {
  handleModelRegistryList,
  handleModelRegistrySearch,
  handleModelRegistryGetModel,
} from "@/server/rpc/handlers/registry";
import { handleSuspend } from "@/server/rpc/handlers/suspend";
import { handleResume } from "@/server/rpc/handlers/resume";
import type { HandlerEntry } from "./handler-utils";

function ragSupportsProgress(request: Request): boolean {
  if (request.type !== "rag") return false;
  return ["ingest", "saveEmbeddings", "reindex"].includes(request.operation);
}

function finetuneSupportsProgress(request: Request): boolean {
  if (request.type !== "finetune") return false;
  return ["start", "resume", undefined].includes(request.operation);
}

function isModelDelegated(request: Request): boolean {
  if (!("modelId" in request)) return false;
  const entry = getModelEntry(request.modelId as string);
  return entry?.isDelegated ?? false;
}

function isCancelDelegated(request: Request): boolean {
  if (request.type !== "cancel") return false;

  if (request.operation === "inference") {
    return isModelDelegated(request);
  }

  if (request.operation === "downloadAsset") {
    return !!request.delegate;
  }

  return false;
}

export const registry: Record<string, HandlerEntry> = {
  // Simple Reply handlers
  heartbeat: {
    type: "reply",
    handler: handleHeartbeat,
    delegatedHandler: handleHeartbeatDelegated,
    isDelegated: (r) => r.type === "heartbeat" && !!r.delegate,
  },
  unloadModel: {
    type: "reply",
    handler: handleUnloadModel,
    delegatedHandler: handleUnloadModelDelegated,
    isDelegated: isModelDelegated,
  },
  embed: { type: "reply", handler: handleEmbed },
  cancel: {
    type: "reply",
    handler: cancelHandler,
    delegatedHandler: handleCancelDelegated,
    isDelegated: isCancelDelegated,
  },
  provide: { type: "reply", handler: provideHandler },
  stopProvide: { type: "reply", handler: stopProvideHandler },
  deleteCache: { type: "reply", handler: handleDeleteCache },
  getModelInfo: { type: "reply", handler: handleGetModelInfo },
  pluginInvoke: { type: "reply", handler: handlePluginInvoke },
  modelRegistryList: { type: "reply", handler: handleModelRegistryList },
  modelRegistrySearch: { type: "reply", handler: handleModelRegistrySearch },
  modelRegistryGetModel: {
    type: "reply",
    handler: handleModelRegistryGetModel,
  },
  suspend: { type: "reply", handler: handleSuspend },
  resume: { type: "reply", handler: handleResume },

  // Simple Stream handlers
  transcribe: { type: "stream", handler: handleTranscribe },
  transcribeStream: { type: "duplex", handler: handleTranscribeStream },
  loggingStream: { type: "stream", handler: handleLoggingStream },
  translate: { type: "stream", handler: handleTranslate },
  textToSpeech: { type: "stream", handler: handleTextToSpeech },
  ocrStream: { type: "stream", handler: handleOCRStream },
  diffusionStream: { type: "stream", handler: handleDiffusionStream },
  pluginInvokeStream: { type: "stream", handler: handlePluginInvokeStream },

  // Handlers with delegation support
  loadModel: {
    type: "reply",
    handler: handleLoadModel,
    delegatedHandler: handleLoadModelDelegated,
    isDelegated: (r) => r.type === "loadModel" && !!r.delegate,
    supportsProgress: true,
  },

  completionStream: {
    type: "stream",
    handler: handleCompletionStream,
    delegatedHandler: handleCompletionStreamDelegated,
    isDelegated: isModelDelegated,
  },

  // Handlers with progress support
  downloadAsset: {
    type: "reply",
    handler: handleDownloadAsset,
    supportsProgress: true,
  },

  rag: {
    type: "reply",
    handler: handleRag,
    supportsProgress: ragSupportsProgress,
  },

  finetune: {
    type: "reply",
    handler: handleFinetune,
    supportsProgress: finetuneSupportsProgress,
  },
};
