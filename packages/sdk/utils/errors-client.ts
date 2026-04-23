import { QvacErrorBase } from "@qvac/error";
import { SDK_CLIENT_ERROR_CODES } from "@/schemas/sdk-errors-client";
import { SDK_SERVER_ERROR_CODES } from "@/schemas/sdk-errors-server";
import { createErrorOptions } from "./errors-base";

// ============== Response Validation Errors ==============

export class InvalidResponseError extends QvacErrorBase {
  constructor(expected: string, cause?: unknown) {
    super(
      createErrorOptions(
        SDK_CLIENT_ERROR_CODES.INVALID_RESPONSE_TYPE,
        [expected],
        cause,
      ),
    );
  }
}

export class InvalidOperationError extends QvacErrorBase {
  constructor(cause?: unknown) {
    super(
      createErrorOptions(
        SDK_CLIENT_ERROR_CODES.INVALID_OPERATION_IN_RESPONSE,
        undefined,
        cause,
      ),
    );
  }
}

export class StreamEndedError extends QvacErrorBase {
  constructor(cause?: unknown) {
    super(
      createErrorOptions(
        SDK_CLIENT_ERROR_CODES.STREAM_ENDED_WITHOUT_RESPONSE,
        undefined,
        cause,
      ),
    );
  }
}

export class InvalidAudioChunkError extends QvacErrorBase {
  constructor(cause?: unknown) {
    super(
      createErrorOptions(
        SDK_CLIENT_ERROR_CODES.INVALID_AUDIO_CHUNK_TYPE,
        undefined,
        cause,
      ),
    );
  }
}

export class InvalidToolsArrayError extends QvacErrorBase {
  constructor(cause?: unknown) {
    super(
      createErrorOptions(
        SDK_CLIENT_ERROR_CODES.INVALID_TOOLS_ARRAY,
        undefined,
        cause,
      ),
    );
  }
}

export class InvalidToolSchemaError extends QvacErrorBase {
  constructor(details: string, cause?: unknown) {
    super(
      createErrorOptions(
        SDK_CLIENT_ERROR_CODES.INVALID_TOOL_SCHEMA,
        [details],
        cause,
      ),
    );
  }
}

export class OCRFailedError extends QvacErrorBase {
  constructor(details?: string, cause?: unknown) {
    super(
      createErrorOptions(
        SDK_CLIENT_ERROR_CODES.OCR_FAILED,
        details ? [details] : undefined,
        cause,
      ),
    );
  }
}

// ============== RPC Communication Errors ==============

export class RPCNoHandlerError extends QvacErrorBase {
  constructor(requestType: string, cause?: unknown) {
    super(
      createErrorOptions(
        SDK_CLIENT_ERROR_CODES.RPC_NO_HANDLER,
        [requestType],
        cause,
      ),
    );
  }
}

export class RPCRequestNotSentError extends QvacErrorBase {
  constructor(cause?: unknown) {
    super(
      createErrorOptions(
        SDK_CLIENT_ERROR_CODES.RPC_REQUEST_NOT_SENT,
        undefined,
        cause,
      ),
    );
  }
}

export class RPCResponseStreamNotCreatedError extends QvacErrorBase {
  constructor(cause?: unknown) {
    super(
      createErrorOptions(
        SDK_CLIENT_ERROR_CODES.RPC_RESPONSE_STREAM_NOT_CREATED,
        undefined,
        cause,
      ),
    );
  }
}

export class RPCConnectionFailedError extends QvacErrorBase {
  constructor(details: string, cause?: unknown) {
    super(
      createErrorOptions(
        SDK_CLIENT_ERROR_CODES.RPC_CONNECTION_FAILED,
        [details],
        cause,
      ),
    );
  }
}

export class RPCInitTimeoutError extends QvacErrorBase {
  constructor(timeoutMs: number, cause?: unknown) {
    super(
      createErrorOptions(
        SDK_CLIENT_ERROR_CODES.RPC_INIT_TIMEOUT,
        [timeoutMs],
        cause,
      ),
    );
  }
}

// ============== Provider/Delegation Errors ==============

export class ProviderStartFailedError extends QvacErrorBase {
  constructor(details?: string, cause?: unknown) {
    super(
      createErrorOptions(
        SDK_CLIENT_ERROR_CODES.PROVIDER_START_FAILED,
        details ? [details] : undefined,
        cause,
      ),
    );
  }
}

export class ProviderStopFailedError extends QvacErrorBase {
  constructor(details?: string, cause?: unknown) {
    super(
      createErrorOptions(
        SDK_CLIENT_ERROR_CODES.PROVIDER_STOP_FAILED,
        details ? [details] : undefined,
        cause,
      ),
    );
  }
}

export class DelegateNoFinalResponseError extends QvacErrorBase {
  constructor(cause?: unknown) {
    super(
      createErrorOptions(
        SDK_CLIENT_ERROR_CODES.DELEGATE_NO_FINAL_RESPONSE,
        undefined,
        cause,
      ),
    );
  }
}

export class DelegateProviderError extends QvacErrorBase {
  constructor(details: string, cause?: unknown) {
    super(
      createErrorOptions(
        SDK_CLIENT_ERROR_CODES.DELEGATE_PROVIDER_ERROR,
        [details],
        cause,
      ),
    );
  }
}

export class DelegateConnectionFailedError extends QvacErrorBase {
  constructor(details: string, cause?: unknown) {
    super(
      createErrorOptions(
        SDK_CLIENT_ERROR_CODES.DELEGATE_CONNECTION_FAILED,
        [details],
        cause,
      ),
    );
  }
}

// ============== Build/Bundle Errors ==============

export class SDKNotFoundInNodeModulesError extends QvacErrorBase {
  constructor(cause?: unknown) {
    super(
      createErrorOptions(
        SDK_CLIENT_ERROR_CODES.SDK_NOT_FOUND_IN_NODE_MODULES,
        undefined,
        cause,
      ),
    );
  }
}

export class MultipleSDKInstallationsError extends QvacErrorBase {
  constructor(packages: string, cause?: unknown) {
    super(
      createErrorOptions(
        SDK_CLIENT_ERROR_CODES.MULTIPLE_SDK_INSTALLATIONS,
        [packages],
        cause,
      ),
    );
  }
}

export class WorkerFileNotFoundError extends QvacErrorBase {
  constructor(workerPath: string, cause?: unknown) {
    super(
      createErrorOptions(
        SDK_CLIENT_ERROR_CODES.WORKER_FILE_NOT_FOUND,
        [workerPath],
        cause,
      ),
    );
  }
}

export class PearWorkerEntryRequiredError extends QvacErrorBase {
  constructor(workerEntry: string, cause?: unknown) {
    super(
      createErrorOptions(
        SDK_CLIENT_ERROR_CODES.PEAR_WORKER_ENTRY_REQUIRED,
        [workerEntry],
        cause,
      ),
    );
  }
}

export class ConfigFileNotFoundError extends QvacErrorBase {
  constructor(searchPaths: string, cause?: unknown) {
    super(
      createErrorOptions(
        SDK_CLIENT_ERROR_CODES.CONFIG_FILE_NOT_FOUND,
        [searchPaths],
        cause,
      ),
    );
  }
}

export class ConfigFileInvalidError extends QvacErrorBase {
  constructor(filePath: string, reason: string, cause?: unknown) {
    super(
      createErrorOptions(
        SDK_CLIENT_ERROR_CODES.CONFIG_FILE_INVALID,
        [filePath, reason],
        cause,
      ),
    );
  }
}

export class ConfigFileParseFailedError extends QvacErrorBase {
  constructor(filePath: string, error: string, cause?: unknown) {
    super(
      createErrorOptions(
        SDK_CLIENT_ERROR_CODES.CONFIG_FILE_PARSE_FAILED,
        [filePath, error],
        cause,
      ),
    );
  }
}

export class ConfigValidationFailedError extends QvacErrorBase {
  constructor(errors: string, cause?: unknown) {
    super(
      createErrorOptions(
        SDK_CLIENT_ERROR_CODES.CONFIG_VALIDATION_FAILED,
        [errors],
        cause,
      ),
    );
  }
}

// ============== Operation Errors (Client-side wrappers for server operations) ==============
// These are used by client API to throw errors based on server responses
// They reference server error codes but are thrown on client side

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

export class RAGChunkFailedError extends QvacErrorBase {
  constructor(details?: string, cause?: unknown) {
    super(
      createErrorOptions(
        SDK_SERVER_ERROR_CODES.RAG_CHUNK_FAILED,
        details ? [details] : undefined,
        cause,
      ),
    );
  }
}

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

export class RAGCloseWorkspaceFailedError extends QvacErrorBase {
  constructor(details?: string, cause?: unknown) {
    super(
      createErrorOptions(
        SDK_SERVER_ERROR_CODES.RAG_WORKSPACE_CLOSE_FAILED,
        details ? [details] : undefined,
        cause,
      ),
    );
  }
}

export class RAGListWorkspacesFailedError extends QvacErrorBase {
  constructor(details?: string, cause?: unknown) {
    super(
      createErrorOptions(
        SDK_SERVER_ERROR_CODES.RAG_LIST_WORKSPACES_FAILED,
        details ? [details] : undefined,
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

export class SetConfigFailedError extends QvacErrorBase {
  constructor(details?: string, cause?: unknown) {
    super(
      createErrorOptions(
        SDK_SERVER_ERROR_CODES.SET_CONFIG_FAILED,
        details ? [details] : undefined,
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

// ============== Profiler Errors ==============

export class ProfilerInvalidCapacityError extends QvacErrorBase {
  constructor(minCapacity: number, cause?: unknown) {
    super(
      createErrorOptions(
        SDK_CLIENT_ERROR_CODES.PROFILER_INVALID_CAPACITY,
        [minCapacity],
        cause,
      ),
    );
  }
}
