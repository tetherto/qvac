import { addCodes, type ErrorCodesMap } from "@qvac/error";

// Server-side error codes (52,001-54,000 range for this SDK)
export const SDK_SERVER_ERROR_CODES = {
  // Model Registry Errors (52,001-52,199)
  MODEL_ALREADY_REGISTERED: 52001,
  MODEL_NOT_FOUND: 52002,
  MODEL_NOT_LOADED: 52003,
  MODEL_IS_DELEGATED: 52004,
  UNKNOWN_MODEL_TYPE: 52005,

  // Model Loading Errors (52,200-52,399)
  MODEL_LOAD_FAILED: 52200,
  MODEL_FILE_NOT_FOUND: 52201,
  MODEL_FILE_NOT_FOUND_IN_DIR: 52202,
  MODEL_FILE_LOCATE_FAILED: 52203,
  PROJECTION_MODEL_REQUIRED: 52204,
  VAD_MODEL_REQUIRED: 52205,
  TTS_CONFIG_MODEL_REQUIRED: 52206,
  ESPEAK_DATA_PATH_REQUIRED: 52207,

  // Model Operations (52,400-52,799)
  MODEL_UNLOAD_FAILED: 52400,
  EMBED_FAILED: 52401,
  EMBED_NO_EMBEDDINGS: 52402,
  TRANSCRIPTION_FAILED: 52403,
  AUDIO_FILE_NOT_FOUND: 52404,
  TRANSLATION_FAILED: 52405,
  COMPLETION_FAILED: 52406,
  ATTACHMENT_NOT_FOUND: 52407,
  CANCEL_FAILED: 52408,
  TEXT_TO_SPEECH_FAILED: 52409,
  CONFIG_RELOAD_NOT_SUPPORTED: 52410,
  MODEL_TYPE_MISMATCH: 52411,
  OCR_FAILED: 52412,
  IMAGE_FILE_NOT_FOUND: 52413,
  INVALID_IMAGE_INPUT: 52414,

  // RAG Operations (52,800-52,999)
  RAG_SAVE_FAILED: 52800,
  RAG_SEARCH_FAILED: 52801,
  RAG_DELETE_FAILED: 52802,
  RAG_UNKNOWN_OPERATION: 52803,
  RAG_HYPERDB_FAILED: 52804,
  RAG_WORKSPACE_MODEL_MISMATCH: 52805,
  RAG_WORKSPACE_NOT_FOUND: 52806,
  RAG_WORKSPACE_IN_USE: 52807,
  RAG_WORKSPACE_CLOSE_FAILED: 52808,
  RAG_LIST_WORKSPACES_FAILED: 52809,
  RAG_CHUNK_FAILED: 52810,
  RAG_WORKSPACE_NOT_OPEN: 52811,

  // Download/Resource Errors (53,000-53,199)
  FILE_NOT_FOUND: 53000,
  DOWNLOAD_CANCELLED: 53001,
  CHECKSUM_VALIDATION_FAILED: 53002,
  HTTP_ERROR: 53003,
  NO_RESPONSE_BODY: 53004,
  RESPONSE_BODY_NOT_READABLE: 53005,
  NO_BLOB_FOUND: 53006,
  DOWNLOAD_ASSET_FAILED: 53007,
  SEEDING_NOT_SUPPORTED: 53008,
  HYPERDRIVE_DOWNLOAD_FAILED: 53009,
  INVALID_SHARD_URL_PATTERN: 53010,
  ARCHIVE_EXTRACTION_FAILED: 53011,
  ARCHIVE_UNSUPPORTED_TYPE: 53012,
  ARCHIVE_MISSING_SHARDS: 53013,
  PARTIAL_DOWNLOAD_OFFLINE: 53014,

  // Cache Operations (53,200-53,349)
  DELETE_CACHE_FAILED: 53200,
  INVALID_DELETE_CACHE_PARAMS: 53201,
  CACHE_DIR_NOT_ABSOLUTE: 53202,
  CACHE_DIR_NOT_WRITABLE: 53203,

  // Config Operations (53,350-53,499)
  SET_CONFIG_FAILED: 53350,
  CONFIG_ALREADY_SET: 53351,

  // System/Runtime (53,500-53,699)
  FFMPEG_NOT_AVAILABLE: 53500,
  AUDIO_PLAYER_FAILED: 53501,
  INVALID_AUDIO_CHUNK_TYPE: 53502,

  // RPC/Delegation (Server-side) (53,700-53,899)
  DELEGATE_NO_FINAL_RESPONSE: 53700,
  DELEGATE_CONNECTION_FAILED: 53701,
} as const;

const serverErrorDefinitions: ErrorCodesMap = {
  // Model Registry Errors (52,001-52,199)
  [SDK_SERVER_ERROR_CODES.MODEL_ALREADY_REGISTERED]: {
    name: "MODEL_ALREADY_REGISTERED",
    message: (modelId: string) =>
      `Model with ID "${modelId}" is already registered`,
  },
  [SDK_SERVER_ERROR_CODES.MODEL_NOT_FOUND]: {
    name: "MODEL_NOT_FOUND",
    message: (modelId: string) => `Model with ID "${modelId}" not found`,
  },
  [SDK_SERVER_ERROR_CODES.MODEL_NOT_LOADED]: {
    name: "MODEL_NOT_LOADED",
    message: (modelId: string) => `Model with ID "${modelId}" is not loaded`,
  },
  [SDK_SERVER_ERROR_CODES.MODEL_IS_DELEGATED]: {
    name: "MODEL_IS_DELEGATED",
    message: (modelId: string) =>
      `Model "${modelId}" is a delegated model and cannot be accessed directly`,
  },
  [SDK_SERVER_ERROR_CODES.UNKNOWN_MODEL_TYPE]: {
    name: "UNKNOWN_MODEL_TYPE",
    message: (modelType: string) => `Unknown model type: ${modelType}`,
  },

  // Model Loading Errors (52,200-52,399)
  [SDK_SERVER_ERROR_CODES.MODEL_LOAD_FAILED]: {
    name: "MODEL_LOAD_FAILED",
    message: (details?: string) =>
      `Failed to load model${details ? `: ${details}` : ""}`,
  },
  [SDK_SERVER_ERROR_CODES.MODEL_FILE_NOT_FOUND]: {
    name: "MODEL_FILE_NOT_FOUND",
    message: (modelPath: string) => `Model file not found: ${modelPath}`,
  },
  [SDK_SERVER_ERROR_CODES.MODEL_FILE_NOT_FOUND_IN_DIR]: {
    name: "MODEL_FILE_NOT_FOUND_IN_DIR",
    message: (modelFile: string, modelDir: string, modelType: string) =>
      `${modelType} model file ${modelFile} not found in directory ${modelDir}`,
  },
  [SDK_SERVER_ERROR_CODES.MODEL_FILE_LOCATE_FAILED]: {
    name: "MODEL_FILE_LOCATE_FAILED",
    message: (modelType: string, modelPath: string) =>
      `Failed to locate ${modelType} model file: ${modelPath}`,
  },
  [SDK_SERVER_ERROR_CODES.PROJECTION_MODEL_REQUIRED]: {
    name: "PROJECTION_MODEL_REQUIRED",
    message: "Projection model source is required for multimodal LLM models",
  },
  [SDK_SERVER_ERROR_CODES.VAD_MODEL_REQUIRED]: {
    name: "VAD_MODEL_REQUIRED",
    message: "VAD model source is required for this configuration",
  },
  [SDK_SERVER_ERROR_CODES.TTS_CONFIG_MODEL_REQUIRED]: {
    name: "TTS_CONFIG_MODEL_REQUIRED",
    message: "ttsConfigModelPath is required for TTS models",
  },
  [SDK_SERVER_ERROR_CODES.ESPEAK_DATA_PATH_REQUIRED]: {
    name: "ESPEAK_DATA_PATH_REQUIRED",
    message: "eSpeakDataPath is required for TTS models",
  },

  // Model Operations (52,400-52,799)
  [SDK_SERVER_ERROR_CODES.MODEL_UNLOAD_FAILED]: {
    name: "MODEL_UNLOAD_FAILED",
    message: (modelId?: string) =>
      `Failed to unload model${modelId ? ` "${modelId}"` : ""}`,
  },
  [SDK_SERVER_ERROR_CODES.EMBED_FAILED]: {
    name: "EMBED_FAILED",
    message: (details?: string) =>
      `Failed to generate embeddings${details ? `: ${details}` : ""}`,
  },
  [SDK_SERVER_ERROR_CODES.EMBED_NO_EMBEDDINGS]: {
    name: "EMBED_NO_EMBEDDINGS",
    message: "No embeddings returned from model",
  },
  [SDK_SERVER_ERROR_CODES.TRANSCRIPTION_FAILED]: {
    name: "TRANSCRIPTION_FAILED",
    message: (details?: string) =>
      `Transcription failed${details ? `: ${details}` : ""}`,
  },
  [SDK_SERVER_ERROR_CODES.AUDIO_FILE_NOT_FOUND]: {
    name: "AUDIO_FILE_NOT_FOUND",
    message: (filePath: string) =>
      `Audio file not found or not accessible: ${filePath}`,
  },
  [SDK_SERVER_ERROR_CODES.TRANSLATION_FAILED]: {
    name: "TRANSLATION_FAILED",
    message: (details?: string) =>
      `Translation failed${details ? `: ${details}` : ""}`,
  },
  [SDK_SERVER_ERROR_CODES.COMPLETION_FAILED]: {
    name: "COMPLETION_FAILED",
    message: (details?: string) =>
      `Completion failed${details ? `: ${details}` : ""}`,
  },
  [SDK_SERVER_ERROR_CODES.ATTACHMENT_NOT_FOUND]: {
    name: "ATTACHMENT_NOT_FOUND",
    message: (path: string) => `Attachment not found at path: ${path}`,
  },
  [SDK_SERVER_ERROR_CODES.CANCEL_FAILED]: {
    name: "CANCEL_FAILED",
    message: (details?: string) =>
      `Failed to cancel operation${details ? `: ${details}` : ""}`,
  },
  [SDK_SERVER_ERROR_CODES.TEXT_TO_SPEECH_FAILED]: {
    name: "TEXT_TO_SPEECH_FAILED",
    message: (details?: string) =>
      `Text-to-speech operation failed${details ? `: ${details}` : ""}`,
  },
  [SDK_SERVER_ERROR_CODES.CONFIG_RELOAD_NOT_SUPPORTED]: {
    name: "CONFIG_RELOAD_NOT_SUPPORTED",
    message: (modelId: string) =>
      `Model "${modelId}" does not support hot config reload`,
  },
  [SDK_SERVER_ERROR_CODES.MODEL_TYPE_MISMATCH]: {
    name: "MODEL_TYPE_MISMATCH",
    message: (expectedType: string, providedType: string) =>
      `Model type mismatch: expected "${expectedType}", got "${providedType}"`,
  },
  [SDK_SERVER_ERROR_CODES.OCR_FAILED]: {
    name: "OCR_FAILED",
    message: (details?: string) =>
      `OCR operation failed${details ? `: ${details}` : ""}`,
  },
  [SDK_SERVER_ERROR_CODES.IMAGE_FILE_NOT_FOUND]: {
    name: "IMAGE_FILE_NOT_FOUND",
    message: (filePath: string) =>
      `Image file not found or not accessible: ${filePath}`,
  },
  [SDK_SERVER_ERROR_CODES.INVALID_IMAGE_INPUT]: {
    name: "INVALID_IMAGE_INPUT",
    message: "Invalid image input type provided",
  },

  // RAG Operations (52,800-52,999)
  [SDK_SERVER_ERROR_CODES.RAG_SAVE_FAILED]: {
    name: "RAG_SAVE_FAILED",
    message: (details?: string) =>
      `Failed to save embeddings${details ? `: ${details}` : ""}`,
  },
  [SDK_SERVER_ERROR_CODES.RAG_SEARCH_FAILED]: {
    name: "RAG_SEARCH_FAILED",
    message: (details?: string) =>
      `Failed to search embeddings${details ? `: ${details}` : ""}`,
  },
  [SDK_SERVER_ERROR_CODES.RAG_DELETE_FAILED]: {
    name: "RAG_DELETE_FAILED",
    message: (details?: string) =>
      `Failed to delete embeddings${details ? `: ${details}` : ""}`,
  },
  [SDK_SERVER_ERROR_CODES.RAG_UNKNOWN_OPERATION]: {
    name: "RAG_UNKNOWN_OPERATION",
    message: (operation: string) => `Unknown RAG operation: ${operation}`,
  },
  [SDK_SERVER_ERROR_CODES.RAG_HYPERDB_FAILED]: {
    name: "RAG_HYPERDB_FAILED",
    message: (details: string) => `HyperDB RAG operation failed: ${details}`,
  },
  [SDK_SERVER_ERROR_CODES.RAG_WORKSPACE_MODEL_MISMATCH]: {
    name: "RAG_WORKSPACE_MODEL_MISMATCH",
    message: (workspace: string, existingModelId: string, newModelId: string) =>
      `Workspace "${workspace}" is configured for model "${existingModelId}", but you're trying to use model "${newModelId}". Use a different workspace or the same model`,
  },
  [SDK_SERVER_ERROR_CODES.RAG_WORKSPACE_NOT_FOUND]: {
    name: "RAG_WORKSPACE_NOT_FOUND",
    message: (workspace: string) => `RAG workspace not found: ${workspace}`,
  },
  [SDK_SERVER_ERROR_CODES.RAG_WORKSPACE_IN_USE]: {
    name: "RAG_WORKSPACE_IN_USE",
    message: (workspace: string) =>
      `RAG workspace '${workspace}' is currently in use. Close it first.`,
  },
  [SDK_SERVER_ERROR_CODES.RAG_WORKSPACE_CLOSE_FAILED]: {
    name: "RAG_WORKSPACE_CLOSE_FAILED",
    message: (details?: string) =>
      `Failed to close RAG workspace${details ? `: ${details}` : ""}`,
  },
  [SDK_SERVER_ERROR_CODES.RAG_LIST_WORKSPACES_FAILED]: {
    name: "RAG_LIST_WORKSPACES_FAILED",
    message: (details?: string) =>
      `Failed to list RAG workspaces${details ? `: ${details}` : ""}`,
  },
  [SDK_SERVER_ERROR_CODES.RAG_CHUNK_FAILED]: {
    name: "RAG_CHUNK_FAILED",
    message: (details?: string) =>
      `Failed to chunk documents${details ? `: ${details}` : ""}`,
  },
  [SDK_SERVER_ERROR_CODES.RAG_WORKSPACE_NOT_OPEN]: {
    name: "RAG_WORKSPACE_NOT_OPEN",
    message: (workspace: string) => `RAG workspace '${workspace}' is not open`,
  },

  // Download/Resource Errors (53,000-53,199)
  [SDK_SERVER_ERROR_CODES.FILE_NOT_FOUND]: {
    name: "FILE_NOT_FOUND",
    message: (path: string) => `File not found: ${path}`,
  },
  [SDK_SERVER_ERROR_CODES.DOWNLOAD_CANCELLED]: {
    name: "DOWNLOAD_CANCELLED",
    message: "Download was cancelled",
  },
  [SDK_SERVER_ERROR_CODES.CHECKSUM_VALIDATION_FAILED]: {
    name: "CHECKSUM_VALIDATION_FAILED",
    message: (fileName: string) => `Checksum validation failed for ${fileName}`,
  },
  [SDK_SERVER_ERROR_CODES.HTTP_ERROR]: {
    name: "HTTP_ERROR",
    message: (status: number, statusText: string) =>
      `HTTP error: ${status} ${statusText}`,
  },
  [SDK_SERVER_ERROR_CODES.NO_RESPONSE_BODY]: {
    name: "NO_RESPONSE_BODY",
    message: "No response body received from HTTP request",
  },
  [SDK_SERVER_ERROR_CODES.RESPONSE_BODY_NOT_READABLE]: {
    name: "RESPONSE_BODY_NOT_READABLE",
    message: "Response body is not readable",
  },
  [SDK_SERVER_ERROR_CODES.NO_BLOB_FOUND]: {
    name: "NO_BLOB_FOUND",
    message: (fileName: string) => `No blob found for ${fileName}`,
  },
  [SDK_SERVER_ERROR_CODES.DOWNLOAD_ASSET_FAILED]: {
    name: "DOWNLOAD_ASSET_FAILED",
    message: (details?: string) =>
      `Failed to download asset${details ? `: ${details}` : ""}`,
  },
  [SDK_SERVER_ERROR_CODES.SEEDING_NOT_SUPPORTED]: {
    name: "SEEDING_NOT_SUPPORTED",
    message: "Seeding is only supported for hyperdrive models",
  },
  [SDK_SERVER_ERROR_CODES.HYPERDRIVE_DOWNLOAD_FAILED]: {
    name: "HYPERDRIVE_DOWNLOAD_FAILED",
    message: (details: string) => `Hyperdrive download failed: ${details}`,
  },
  [SDK_SERVER_ERROR_CODES.INVALID_SHARD_URL_PATTERN]: {
    name: "INVALID_SHARD_URL_PATTERN",
    message: (url: string) =>
      `URL does not contain a valid sharded model pattern: ${url}`,
  },
  [SDK_SERVER_ERROR_CODES.ARCHIVE_EXTRACTION_FAILED]: {
    name: "ARCHIVE_EXTRACTION_FAILED",
    message: (archivePath: string) =>
      `Failed to extract archive: ${archivePath}`,
  },
  [SDK_SERVER_ERROR_CODES.ARCHIVE_UNSUPPORTED_TYPE]: {
    name: "ARCHIVE_UNSUPPORTED_TYPE",
    message: (archivePath: string) =>
      `Unsupported archive type: ${archivePath}`,
  },
  [SDK_SERVER_ERROR_CODES.ARCHIVE_MISSING_SHARDS]: {
    name: "ARCHIVE_MISSING_SHARDS",
    message: (missingFile: string) =>
      `Archive is missing required shard file: ${missingFile}`,
  },
  [SDK_SERVER_ERROR_CODES.PARTIAL_DOWNLOAD_OFFLINE]: {
    name: "PARTIAL_DOWNLOAD_OFFLINE",
    message: (url: string, downloadedBytes: string) =>
      `Cannot resume partial download (${downloadedBytes} bytes downloaded) - unable to connect. URL: ${url}`,
  },

  // Cache Operations (53,200-53,349)
  [SDK_SERVER_ERROR_CODES.DELETE_CACHE_FAILED]: {
    name: "DELETE_CACHE_FAILED",
    message: (details?: string) =>
      `Failed to delete cache${details ? `: ${details}` : ""}`,
  },
  [SDK_SERVER_ERROR_CODES.INVALID_DELETE_CACHE_PARAMS]: {
    name: "INVALID_DELETE_CACHE_PARAMS",
    message:
      "Invalid deleteCache parameters - provide either modelId or cacheKey",
  },
  [SDK_SERVER_ERROR_CODES.CACHE_DIR_NOT_ABSOLUTE]: {
    name: "CACHE_DIR_NOT_ABSOLUTE",
    message: "Cache directory must be an absolute path",
  },
  [SDK_SERVER_ERROR_CODES.CACHE_DIR_NOT_WRITABLE]: {
    name: "CACHE_DIR_NOT_WRITABLE",
    message: (cacheDir: string, details?: string) =>
      `Cache directory is not writable: ${cacheDir}${details ? `. ${details}` : ""}`,
  },

  // Config Operations (53,350-53,499)
  [SDK_SERVER_ERROR_CODES.SET_CONFIG_FAILED]: {
    name: "SET_CONFIG_FAILED",
    message: (details?: string) =>
      `Failed to set config${details ? `: ${details}` : ""}`,
  },
  [SDK_SERVER_ERROR_CODES.CONFIG_ALREADY_SET]: {
    name: "CONFIG_ALREADY_SET",
    message:
      "Config has already been set and is immutable. Config can only be set once during SDK initialization.",
  },

  // System/Runtime (53,500-53,699)
  [SDK_SERVER_ERROR_CODES.FFMPEG_NOT_AVAILABLE]: {
    name: "FFMPEG_NOT_AVAILABLE",
    message: "FFmpeg is not available on this system",
  },
  [SDK_SERVER_ERROR_CODES.AUDIO_PLAYER_FAILED]: {
    name: "AUDIO_PLAYER_FAILED",
    message: (details: string) => `Audio player failed: ${details}`,
  },
  [SDK_SERVER_ERROR_CODES.INVALID_AUDIO_CHUNK_TYPE]: {
    name: "INVALID_AUDIO_CHUNK_TYPE",
    message: "Invalid audio chunk type",
  },

  // RPC/Delegation (Server-side) (53,700-53,899)
  [SDK_SERVER_ERROR_CODES.DELEGATE_NO_FINAL_RESPONSE]: {
    name: "DELEGATE_NO_FINAL_RESPONSE",
    message: "No final response received from delegated provider",
  },
  [SDK_SERVER_ERROR_CODES.DELEGATE_CONNECTION_FAILED]: {
    name: "DELEGATE_CONNECTION_FAILED",
    message: (details: string) =>
      `Failed to connect to delegated provider: ${details}`,
  },
};

addCodes(serverErrorDefinitions, { name: "qvac-sdk-server", version: "1.1.0" });

export { serverErrorDefinitions as SDK_SERVER_ERROR_DEFINITIONS };
