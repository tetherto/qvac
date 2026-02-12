import { handleCompletionStream } from "./completion-stream";
import { handleDownloadAsset } from "./download-asset";
import { handleLoadModel } from "./load-model";
import { handleUnloadModel } from "./unload-model";
import { handleEmbed } from "./embed";
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
import { handleOCRStream } from "./ocr-stream";

export const handlers = {
  completionStream: handleCompletionStream,
  downloadAsset: handleDownloadAsset,
  deleteCache: handleDeleteCache,
  loadModel: handleLoadModel,
  unloadModel: handleUnloadModel,
  embed: handleEmbed,
  transcribeStream: handleTranscribeStream,
  provide: provideHandler,
  stopProvide: stopProvideHandler,
  translate: handleTranslate,
  loggingStream: handleLoggingStream,
  rag: handleRag,
  cancel: cancelHandler,
  textToSpeech: handleTextToSpeech,
  getModelInfo: handleGetModelInfo,
  ocrStream: handleOCRStream,
};
