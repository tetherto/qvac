import { QvacErrorBase } from "@qvac/error";
import { SDK_SERVER_ERROR_CODES } from "@/schemas/sdk-errors-server";
import { createErrorOptions } from "./errors-base";

// ============== Model Registry Errors ==============

export class ModelAlreadyRegisteredError extends QvacErrorBase {
  constructor(modelId: string, cause?: unknown) {
    super(
      createErrorOptions(
        SDK_SERVER_ERROR_CODES.MODEL_ALREADY_REGISTERED,
        [modelId],
        cause,
      ),
    );
  }
}

export class ModelNotFoundError extends QvacErrorBase {
  constructor(modelId: string, cause?: unknown) {
    super(
      createErrorOptions(
        SDK_SERVER_ERROR_CODES.MODEL_NOT_FOUND,
        [modelId],
        cause,
      ),
    );
  }
}

export class ModelNotLoadedError extends QvacErrorBase {
  constructor(modelId: string, cause?: unknown) {
    super(
      createErrorOptions(
        SDK_SERVER_ERROR_CODES.MODEL_NOT_LOADED,
        [modelId],
        cause,
      ),
    );
  }
}

export class ModelIsDelegatedError extends QvacErrorBase {
  constructor(modelId: string, cause?: unknown) {
    super(
      createErrorOptions(
        SDK_SERVER_ERROR_CODES.MODEL_IS_DELEGATED,
        [modelId],
        cause,
      ),
    );
  }
}

// ============== Model Loading Errors ==============

export class ModelLoadFailedError extends QvacErrorBase {
  constructor(details?: string, cause?: unknown) {
    super(
      createErrorOptions(
        SDK_SERVER_ERROR_CODES.MODEL_LOAD_FAILED,
        details ? [details] : undefined,
        cause,
      ),
    );
  }
}

export class ModelFileNotFoundError extends QvacErrorBase {
  constructor(modelPath: string, cause?: unknown) {
    super(
      createErrorOptions(
        SDK_SERVER_ERROR_CODES.MODEL_FILE_NOT_FOUND,
        [modelPath],
        cause,
      ),
    );
  }
}

export class ModelFileNotFoundInDirError extends QvacErrorBase {
  constructor(
    modelFile: string,
    modelDir: string,
    modelType: string,
    cause?: unknown,
  ) {
    super(
      createErrorOptions(
        SDK_SERVER_ERROR_CODES.MODEL_FILE_NOT_FOUND_IN_DIR,
        [modelFile, modelDir, modelType],
        cause,
      ),
    );
  }
}

export class ModelFileLocateFailedError extends QvacErrorBase {
  constructor(modelType: string, modelPath: string, cause?: unknown) {
    super(
      createErrorOptions(
        SDK_SERVER_ERROR_CODES.MODEL_FILE_LOCATE_FAILED,
        [modelType, modelPath],
        cause,
      ),
    );
  }
}

export class ProjectionModelRequiredError extends QvacErrorBase {
  constructor(cause?: unknown) {
    super(
      createErrorOptions(
        SDK_SERVER_ERROR_CODES.PROJECTION_MODEL_REQUIRED,
        undefined,
        cause,
      ),
    );
  }
}

export class VADModelRequiredError extends QvacErrorBase {
  constructor(cause?: unknown) {
    super(
      createErrorOptions(
        SDK_SERVER_ERROR_CODES.VAD_MODEL_REQUIRED,
        undefined,
        cause,
      ),
    );
  }
}

export class TtsArtifactsRequiredError extends QvacErrorBase {
  constructor(cause?: unknown) {
    super(
      createErrorOptions(
        SDK_SERVER_ERROR_CODES.TTS_ARTIFACTS_REQUIRED,
        undefined,
        cause,
      ),
    );
  }
}

export class TtsReferenceAudioRequiredError extends QvacErrorBase {
  constructor(cause?: unknown) {
    super(
      createErrorOptions(
        SDK_SERVER_ERROR_CODES.TTS_REFERENCE_AUDIO_REQUIRED,
        undefined,
        cause,
      ),
    );
  }
}

export class ParakeetArtifactsRequiredError extends QvacErrorBase {
  constructor(details?: string, cause?: unknown) {
    super(
      createErrorOptions(
        SDK_SERVER_ERROR_CODES.PARAKEET_ARTIFACTS_REQUIRED,
        details ? [details] : undefined,
        cause,
      ),
    );
  }
}

// ============== Model Unloading Errors ==============

export class ModelUnloadFailedError extends QvacErrorBase {
  constructor(modelId?: string, cause?: unknown) {
    super(
      createErrorOptions(
        SDK_SERVER_ERROR_CODES.MODEL_UNLOAD_FAILED,
        modelId ? [modelId] : undefined,
        cause,
      ),
    );
  }
}

// ============== Model Operation Errors ==============

export class EmbedFailedError extends QvacErrorBase {
  constructor(details?: string, cause?: unknown) {
    super(
      createErrorOptions(
        SDK_SERVER_ERROR_CODES.EMBED_FAILED,
        details ? [details] : undefined,
        cause,
      ),
    );
  }
}

export class EmbedNoEmbeddingsError extends QvacErrorBase {
  constructor(cause?: unknown) {
    super(
      createErrorOptions(
        SDK_SERVER_ERROR_CODES.EMBED_NO_EMBEDDINGS,
        undefined,
        cause,
      ),
    );
  }
}

export class TranscriptionFailedError extends QvacErrorBase {
  constructor(details?: string, cause?: unknown) {
    super(
      createErrorOptions(
        SDK_SERVER_ERROR_CODES.TRANSCRIPTION_FAILED,
        details ? [details] : undefined,
        cause,
      ),
    );
  }
}

export class AudioFileNotFoundError extends QvacErrorBase {
  constructor(filePath: string, cause?: unknown) {
    super(
      createErrorOptions(
        SDK_SERVER_ERROR_CODES.AUDIO_FILE_NOT_FOUND,
        [filePath],
        cause,
      ),
    );
  }
}

export class TranslationFailedError extends QvacErrorBase {
  constructor(details?: string, cause?: unknown) {
    super(
      createErrorOptions(
        SDK_SERVER_ERROR_CODES.TRANSLATION_FAILED,
        details ? [details] : undefined,
        cause,
      ),
    );
  }
}

export class CompletionFailedError extends QvacErrorBase {
  constructor(details?: string, cause?: unknown) {
    super(
      createErrorOptions(
        SDK_SERVER_ERROR_CODES.COMPLETION_FAILED,
        details ? [details] : undefined,
        cause,
      ),
    );
  }
}

export class AttachmentNotFoundError extends QvacErrorBase {
  constructor(path: string, cause?: unknown) {
    super(
      createErrorOptions(
        SDK_SERVER_ERROR_CODES.ATTACHMENT_NOT_FOUND,
        [path],
        cause,
      ),
    );
  }
}

export class CancelFailedError extends QvacErrorBase {
  constructor(details?: string, cause?: unknown) {
    super(
      createErrorOptions(
        SDK_SERVER_ERROR_CODES.CANCEL_FAILED,
        details ? [details] : undefined,
        cause,
      ),
    );
  }
}

export class TextToSpeechFailedError extends QvacErrorBase {
  constructor(details?: string, cause?: unknown) {
    super(
      createErrorOptions(
        SDK_SERVER_ERROR_CODES.TEXT_TO_SPEECH_FAILED,
        details ? [details] : undefined,
        cause,
      ),
    );
  }
}

export class ConfigReloadNotSupportedError extends QvacErrorBase {
  constructor(modelId: string, cause?: unknown) {
    super(
      createErrorOptions(
        SDK_SERVER_ERROR_CODES.CONFIG_RELOAD_NOT_SUPPORTED,
        [modelId],
        cause,
      ),
    );
  }
}

export class ModelTypeMismatchError extends QvacErrorBase {
  constructor(expectedType: string, providedType: string, cause?: unknown) {
    super(
      createErrorOptions(
        SDK_SERVER_ERROR_CODES.MODEL_TYPE_MISMATCH,
        [expectedType, providedType],
        cause,
      ),
    );
  }
}

export class OCRFailedError extends QvacErrorBase {
  constructor(details?: string, cause?: unknown) {
    super(
      createErrorOptions(
        SDK_SERVER_ERROR_CODES.OCR_FAILED,
        details ? [details] : undefined,
        cause,
      ),
    );
  }
}

export class ImageFileNotFoundError extends QvacErrorBase {
  constructor(filePath: string, cause?: unknown) {
    super(
      createErrorOptions(
        SDK_SERVER_ERROR_CODES.IMAGE_FILE_NOT_FOUND,
        [filePath],
        cause,
      ),
    );
  }
}

export class InvalidImageInputError extends QvacErrorBase {
  constructor(cause?: unknown) {
    super(
      createErrorOptions(
        SDK_SERVER_ERROR_CODES.INVALID_IMAGE_INPUT,
        undefined,
        cause,
      ),
    );
  }
}

// ============== RAG Operation Errors ==============

export class RAGSaveFailedError extends QvacErrorBase {
  constructor(details?: string, cause?: unknown) {
    super(
      createErrorOptions(
        SDK_SERVER_ERROR_CODES.RAG_SAVE_FAILED,
        details ? [details] : undefined,
        cause,
      ),
    );
  }
}

export class RAGSearchFailedError extends QvacErrorBase {
  constructor(details?: string, cause?: unknown) {
    super(
      createErrorOptions(
        SDK_SERVER_ERROR_CODES.RAG_SEARCH_FAILED,
        details ? [details] : undefined,
        cause,
      ),
    );
  }
}

export class RAGDeleteFailedError extends QvacErrorBase {
  constructor(details?: string, cause?: unknown) {
    super(
      createErrorOptions(
        SDK_SERVER_ERROR_CODES.RAG_DELETE_FAILED,
        details ? [details] : undefined,
        cause,
      ),
    );
  }
}

export class RAGUnknownOperationError extends QvacErrorBase {
  constructor(operation: string, cause?: unknown) {
    super(
      createErrorOptions(
        SDK_SERVER_ERROR_CODES.RAG_UNKNOWN_OPERATION,
        [operation],
        cause,
      ),
    );
  }
}

export class RAGHyperDBFailedError extends QvacErrorBase {
  constructor(details: string, cause?: unknown) {
    super(
      createErrorOptions(
        SDK_SERVER_ERROR_CODES.RAG_HYPERDB_FAILED,
        [details],
        cause,
      ),
    );
  }
}

// ============== Download/Resource Errors ==============

export class FileNotFoundError extends QvacErrorBase {
  constructor(path: string, cause?: unknown) {
    super(
      createErrorOptions(SDK_SERVER_ERROR_CODES.FILE_NOT_FOUND, [path], cause),
    );
  }
}

export class DownloadCancelledError extends QvacErrorBase {
  constructor(cause?: unknown) {
    super(
      createErrorOptions(
        SDK_SERVER_ERROR_CODES.DOWNLOAD_CANCELLED,
        undefined,
        cause,
      ),
    );
  }
}

export class ChecksumValidationFailedError extends QvacErrorBase {
  constructor(fileName: string, cause?: unknown) {
    super(
      createErrorOptions(
        SDK_SERVER_ERROR_CODES.CHECKSUM_VALIDATION_FAILED,
        [fileName],
        cause,
      ),
    );
  }
}

export class HTTPError extends QvacErrorBase {
  constructor(status: number, statusText: string, cause?: unknown) {
    super(
      createErrorOptions(
        SDK_SERVER_ERROR_CODES.HTTP_ERROR,
        [status, statusText],
        cause,
      ),
    );
  }
}

export class NoResponseBodyError extends QvacErrorBase {
  constructor(cause?: unknown) {
    super(
      createErrorOptions(
        SDK_SERVER_ERROR_CODES.NO_RESPONSE_BODY,
        undefined,
        cause,
      ),
    );
  }
}

export class ResponseBodyNotReadableError extends QvacErrorBase {
  constructor(cause?: unknown) {
    super(
      createErrorOptions(
        SDK_SERVER_ERROR_CODES.RESPONSE_BODY_NOT_READABLE,
        undefined,
        cause,
      ),
    );
  }
}

export class NoBlobFoundError extends QvacErrorBase {
  constructor(fileName: string, cause?: unknown) {
    super(
      createErrorOptions(
        SDK_SERVER_ERROR_CODES.NO_BLOB_FOUND,
        [fileName],
        cause,
      ),
    );
  }
}

export class DownloadAssetFailedError extends QvacErrorBase {
  constructor(details?: string, cause?: unknown) {
    super(
      createErrorOptions(
        SDK_SERVER_ERROR_CODES.DOWNLOAD_ASSET_FAILED,
        details ? [details] : undefined,
        cause,
      ),
    );
  }
}

export class SeedingNotSupportedError extends QvacErrorBase {
  constructor(cause?: unknown) {
    super(
      createErrorOptions(
        SDK_SERVER_ERROR_CODES.SEEDING_NOT_SUPPORTED,
        undefined,
        cause,
      ),
    );
  }
}

export class HyperdriveDownloadFailedError extends QvacErrorBase {
  constructor(details: string, cause?: unknown) {
    super(
      createErrorOptions(
        SDK_SERVER_ERROR_CODES.HYPERDRIVE_DOWNLOAD_FAILED,
        [details],
        cause,
      ),
    );
  }
}

export class RegistryDownloadFailedError extends QvacErrorBase {
  constructor(details: string, cause?: unknown) {
    super(
      createErrorOptions(
        SDK_SERVER_ERROR_CODES.REGISTRY_DOWNLOAD_FAILED,
        [details],
        cause,
      ),
    );
  }
}

export class InvalidShardUrlPatternError extends QvacErrorBase {
  constructor(url: string, cause?: unknown) {
    super(
      createErrorOptions(
        SDK_SERVER_ERROR_CODES.INVALID_SHARD_URL_PATTERN,
        [url],
        cause,
      ),
    );
  }
}

export class ArchiveExtractionFailedError extends QvacErrorBase {
  constructor(archivePath: string, cause?: unknown) {
    super(
      createErrorOptions(
        SDK_SERVER_ERROR_CODES.ARCHIVE_EXTRACTION_FAILED,
        [archivePath],
        cause,
      ),
    );
  }
}

export class ArchiveUnsupportedTypeError extends QvacErrorBase {
  constructor(archivePath: string, cause?: unknown) {
    super(
      createErrorOptions(
        SDK_SERVER_ERROR_CODES.ARCHIVE_UNSUPPORTED_TYPE,
        [archivePath],
        cause,
      ),
    );
  }
}

export class ArchiveMissingShardsError extends QvacErrorBase {
  constructor(missingFile: string, cause?: unknown) {
    super(
      createErrorOptions(
        SDK_SERVER_ERROR_CODES.ARCHIVE_MISSING_SHARDS,
        [missingFile],
        cause,
      ),
    );
  }
}

export class PartialDownloadOfflineError extends QvacErrorBase {
  constructor(url: string, downloadedBytes: number, cause?: unknown) {
    super(
      createErrorOptions(
        SDK_SERVER_ERROR_CODES.PARTIAL_DOWNLOAD_OFFLINE,
        [url, String(downloadedBytes)],
        cause,
      ),
    );
  }
}

// ============== Cache Operation Errors ==============

export class DeleteCacheFailedError extends QvacErrorBase {
  constructor(details?: string, cause?: unknown) {
    super(
      createErrorOptions(
        SDK_SERVER_ERROR_CODES.DELETE_CACHE_FAILED,
        details ? [details] : undefined,
        cause,
      ),
    );
  }
}

export class InvalidDeleteCacheParamsError extends QvacErrorBase {
  constructor(cause?: unknown) {
    super(
      createErrorOptions(
        SDK_SERVER_ERROR_CODES.INVALID_DELETE_CACHE_PARAMS,
        undefined,
        cause,
      ),
    );
  }
}

export class CacheDirNotAbsoluteError extends QvacErrorBase {
  constructor(cause?: unknown) {
    super(
      createErrorOptions(
        SDK_SERVER_ERROR_CODES.CACHE_DIR_NOT_ABSOLUTE,
        undefined,
        cause,
      ),
    );
  }
}

export class CacheDirNotWritableError extends QvacErrorBase {
  constructor(cacheDir: string, details?: string, cause?: unknown) {
    super(
      createErrorOptions(
        SDK_SERVER_ERROR_CODES.CACHE_DIR_NOT_WRITABLE,
        details ? [cacheDir, details] : [cacheDir],
        cause,
      ),
    );
  }
}

// ============== Config Operations Errors ==============

export class ConfigAlreadySetError extends QvacErrorBase {
  constructor(cause?: unknown) {
    super(
      createErrorOptions(
        SDK_SERVER_ERROR_CODES.CONFIG_ALREADY_SET,
        undefined,
        cause,
      ),
    );
  }
}

// ============== System/Runtime Errors ==============

export class FFmpegNotAvailableError extends QvacErrorBase {
  constructor(cause?: unknown) {
    super(
      createErrorOptions(
        SDK_SERVER_ERROR_CODES.FFMPEG_NOT_AVAILABLE,
        undefined,
        cause,
      ),
    );
  }
}

export class AudioPlayerFailedError extends QvacErrorBase {
  constructor(details: string, cause?: unknown) {
    super(
      createErrorOptions(
        SDK_SERVER_ERROR_CODES.AUDIO_PLAYER_FAILED,
        [details],
        cause,
      ),
    );
  }
}

export class InvalidAudioChunkError extends QvacErrorBase {
  constructor(cause?: unknown) {
    super(
      createErrorOptions(
        SDK_SERVER_ERROR_CODES.INVALID_AUDIO_CHUNK_TYPE,
        undefined,
        cause,
      ),
    );
  }
}

// ============== RAG Workspace Errors ==============

export class RAGWorkspaceModelMismatchError extends QvacErrorBase {
  constructor(
    workspace: string,
    existingModelId: string,
    newModelId: string,
    cause?: unknown,
  ) {
    super(
      createErrorOptions(
        SDK_SERVER_ERROR_CODES.RAG_WORKSPACE_MODEL_MISMATCH,
        [workspace, existingModelId, newModelId],
        cause,
      ),
    );
  }
}

export class RAGWorkspaceNotFoundError extends QvacErrorBase {
  constructor(workspace: string, cause?: unknown) {
    super(
      createErrorOptions(
        SDK_SERVER_ERROR_CODES.RAG_WORKSPACE_NOT_FOUND,
        [workspace],
        cause,
      ),
    );
  }
}

export class RAGWorkspaceInUseError extends QvacErrorBase {
  constructor(workspace: string, cause?: unknown) {
    super(
      createErrorOptions(
        SDK_SERVER_ERROR_CODES.RAG_WORKSPACE_IN_USE,
        [workspace],
        cause,
      ),
    );
  }
}

export class RAGWorkspaceNotOpenError extends QvacErrorBase {
  constructor(workspace: string, cause?: unknown) {
    super(
      createErrorOptions(
        SDK_SERVER_ERROR_CODES.RAG_WORKSPACE_NOT_OPEN,
        [workspace],
        cause,
      ),
    );
  }
}

// ============== RPC/Delegation Errors (Server-side) ==============

export class DelegateNoFinalResponseError extends QvacErrorBase {
  constructor(cause?: unknown) {
    super(
      createErrorOptions(
        SDK_SERVER_ERROR_CODES.DELEGATE_NO_FINAL_RESPONSE,
        undefined,
        cause,
      ),
    );
  }
}

export class DelegateConnectionFailedError extends QvacErrorBase {
  constructor(details: string, cause?: unknown) {
    super(
      createErrorOptions(
        SDK_SERVER_ERROR_CODES.DELEGATE_CONNECTION_FAILED,
        [details],
        cause,
      ),
    );
  }
}

export class DelegateProviderError extends QvacErrorBase {
  constructor(details: string, providerCode?: number, cause?: unknown) {
    super(
      createErrorOptions(
        SDK_SERVER_ERROR_CODES.DELEGATE_PROVIDER_ERROR,
        providerCode !== undefined
          ? [details, String(providerCode)]
          : [details],
        cause,
      ),
    );
  }
}

export class RPCNoDataReceivedError extends QvacErrorBase {
  constructor(cause?: unknown) {
    super(
      createErrorOptions(
        SDK_SERVER_ERROR_CODES.RPC_NO_DATA_RECEIVED,
        undefined,
        cause,
      ),
    );
  }
}

export class RPCUnknownRequestTypeError extends QvacErrorBase {
  constructor(requestType: string, cause?: unknown) {
    super(
      createErrorOptions(
        SDK_SERVER_ERROR_CODES.RPC_UNKNOWN_REQUEST_TYPE,
        [requestType],
        cause,
      ),
    );
  }
}

// ============== Plugin Errors ==============

export class PluginNotFoundError extends QvacErrorBase {
  constructor(modelType: string, cause?: unknown) {
    super(
      createErrorOptions(
        SDK_SERVER_ERROR_CODES.PLUGIN_NOT_FOUND,
        [modelType],
        cause,
      ),
    );
  }
}

export class PluginHandlerNotFoundError extends QvacErrorBase {
  constructor(
    modelType: string,
    handler: string,
    availableHandlers?: string[],
    cause?: unknown,
  ) {
    const serializedHandlers = availableHandlers?.join(", ") ?? "";
    super(
      createErrorOptions(
        SDK_SERVER_ERROR_CODES.PLUGIN_HANDLER_NOT_FOUND,
        [modelType, handler, serializedHandlers],
        cause,
      ),
    );
  }
}

export class PluginRequestValidationFailedError extends QvacErrorBase {
  constructor(handler: string, details?: string, cause?: unknown) {
    super(
      createErrorOptions(
        SDK_SERVER_ERROR_CODES.PLUGIN_REQUEST_VALIDATION_FAILED,
        details ? [handler, details] : [handler],
        cause,
      ),
    );
  }
}

export class PluginResponseValidationFailedError extends QvacErrorBase {
  constructor(handler: string, details?: string, cause?: unknown) {
    super(
      createErrorOptions(
        SDK_SERVER_ERROR_CODES.PLUGIN_RESPONSE_VALIDATION_FAILED,
        details ? [handler, details] : [handler],
        cause,
      ),
    );
  }
}

export class PluginAlreadyRegisteredError extends QvacErrorBase {
  constructor(modelType: string, cause?: unknown) {
    super(
      createErrorOptions(
        SDK_SERVER_ERROR_CODES.PLUGIN_ALREADY_REGISTERED,
        [modelType],
        cause,
      ),
    );
  }
}

export class PluginModelTypeReservedError extends QvacErrorBase {
  constructor(modelType: string, cause?: unknown) {
    super(
      createErrorOptions(
        SDK_SERVER_ERROR_CODES.PLUGIN_MODEL_TYPE_RESERVED,
        [modelType],
        cause,
      ),
    );
  }
}

export class PluginLoadConfigValidationFailedError extends QvacErrorBase {
  constructor(modelType: string, details: string, cause?: unknown) {
    super(
      createErrorOptions(
        SDK_SERVER_ERROR_CODES.PLUGIN_LOAD_CONFIG_VALIDATION_FAILED,
        [modelType, details],
        cause,
      ),
    );
  }
}

export class PluginHandlerTypeMismatchError extends QvacErrorBase {
  constructor(
    handlerName: string,
    expected: string,
    actual: string,
    cause?: unknown,
  ) {
    super(
      createErrorOptions(
        SDK_SERVER_ERROR_CODES.PLUGIN_HANDLER_TYPE_MISMATCH,
        [handlerName, expected, actual],
        cause,
      ),
    );
  }
}

export class PluginLoggingInvalidError extends QvacErrorBase {
  constructor(modelType: string, reason: string, cause?: unknown) {
    super(
      createErrorOptions(
        SDK_SERVER_ERROR_CODES.PLUGIN_LOGGING_INVALID,
        [modelType, reason],
        cause,
      ),
    );
  }
}

export class PluginDefinitionInvalidError extends QvacErrorBase {
  constructor(modelType: string, details: string, cause?: unknown) {
    super(
      createErrorOptions(
        SDK_SERVER_ERROR_CODES.PLUGIN_DEFINITION_INVALID,
        [modelType, details],
        cause,
      ),
    );
  }
}

// ============== Lifecycle Errors ==============

export class LifecycleSuspendFailedError extends QvacErrorBase {
  constructor(details?: string, cause?: unknown) {
    super(
      createErrorOptions(
        SDK_SERVER_ERROR_CODES.LIFECYCLE_SUSPEND_FAILED,
        details ? [details] : undefined,
        cause,
      ),
    );
  }
}

export class LifecycleResumeFailedError extends QvacErrorBase {
  constructor(details?: string, cause?: unknown) {
    super(
      createErrorOptions(
        SDK_SERVER_ERROR_CODES.LIFECYCLE_RESUME_FAILED,
        details ? [details] : undefined,
        cause,
      ),
    );
  }
}

// ============== Security Errors ==============

export class PathTraversalError extends QvacErrorBase {
  constructor(component: string, basePath: string, cause?: unknown) {
    super(
      createErrorOptions(
        SDK_SERVER_ERROR_CODES.PATH_TRAVERSAL,
        [component, basePath],
        cause,
      ),
    );
  }
}

// ============== QVAC Model Registry Operation Errors ==============
// Registry client errors (19,001-20,000) are re-thrown directly from @qvac/registry-client
// Only SDK-specific errors are defined here

export class ModelRegistryQueryFailedError extends QvacErrorBase {
  constructor(details?: string, cause?: unknown) {
    super(
      createErrorOptions(
        SDK_SERVER_ERROR_CODES.QVAC_MODEL_REGISTRY_QUERY_FAILED,
        details ? [details] : undefined,
        cause,
      ),
    );
  }
}
