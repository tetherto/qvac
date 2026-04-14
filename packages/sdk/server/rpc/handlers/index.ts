import { handleCompletionStream } from "./completion-stream";
import { handleDownloadAsset } from "./download-asset";
import { handleLoadModel } from "./load-model";
import { handleUnloadModel } from "./unload-model";
import { handleEmbed } from "./embed";
import { handleTranscribe } from "./transcribe";
import { handleTranscribeStream } from "./transcribe-stream";
import { provideHandler } from "./provideHandler";
import { stopProvideHandler } from "./stopProvideHandler";
import { handleTranslate } from "./translate";
import { handleLoggingStream } from "./logging-stream";
import { handleRag } from "./rag";
import { cancelHandler } from "./cancelHandler";
import { handleDeleteCache } from "./delete-cache";
import { handleTextToSpeech } from "./text-to-speech";
import { handleGetModelInfo } from "./get-model-info";
import { handleFinetune } from "./finetune";
import { handleOCRStream } from "./ocr-stream";
import { handleHeartbeat } from "./heartbeat";
import { handleDiffusionStream } from "./diffusion-stream";
import { handlePluginInvoke, handlePluginInvokeStream } from "./plugin-invoke";
import {
  handleModelRegistryList,
  handleModelRegistrySearch,
  handleModelRegistryGetModel,
} from "./registry";

export const handlers = {
  heartbeat: handleHeartbeat,
  completionStream: handleCompletionStream,
  downloadAsset: handleDownloadAsset,
  deleteCache: handleDeleteCache,
  loadModel: handleLoadModel,
  unloadModel: handleUnloadModel,
  embed: handleEmbed,
  transcribe: handleTranscribe,
  transcribeStream: handleTranscribeStream,
  provide: provideHandler,
  stopProvide: stopProvideHandler,
  translate: handleTranslate,
  loggingStream: handleLoggingStream,
  rag: handleRag,
  cancel: cancelHandler,
  textToSpeech: handleTextToSpeech,
  getModelInfo: handleGetModelInfo,
  finetune: handleFinetune,
  ocrStream: handleOCRStream,
  diffusionStream: handleDiffusionStream,
  pluginInvoke: handlePluginInvoke,
  pluginInvokeStream: handlePluginInvokeStream,
  modelRegistryList: handleModelRegistryList,
  modelRegistrySearch: handleModelRegistrySearch,
  modelRegistryGetModel: handleModelRegistryGetModel,
};
