import { addCodes, type ErrorCodesMap } from '@qvac/error'

// Numeric error codes for the whole library. Consumers match on the number, so
// the values are a stable contract. Ranges group codes by domain.
export const ERROR_CODES = {
  // Response / request validation (50,001-50,199)
  INVALID_RESPONSE_TYPE: 50001,
  INVALID_OPERATION_IN_RESPONSE: 50002,
  STREAM_ENDED_WITHOUT_RESPONSE: 50003,
  INVALID_TOOLS_ARRAY: 50005,
  INVALID_TOOL_SCHEMA: 50006,
  MODEL_TYPE_REQUIRED: 50008,
  MODEL_SRC_TYPE_MISMATCH: 50009,
  REQUEST_VALIDATION_FAILED: 50010,

  // Dispatch (50,200-50,399)
  RPC_NO_HANDLER: 50200,

  // Provider / delegation, consumer side (50,400-50,599)
  PROVIDER_START_FAILED: 50400,
  PROVIDER_STOP_FAILED: 50401,

  // Config file resolution (50,600-50,799)
  CONFIG_FILE_INVALID: 50603,
  CONFIG_FILE_PARSE_FAILED: 50604,
  CONFIG_VALIDATION_FAILED: 50605,
  PLUGINS_NOT_REGISTERED: 50608,

  // Profiler (50,800-50,899)
  PROFILER_INVALID_CAPACITY: 50800,

  // Model registry (52,001-52,199)
  MODEL_ALREADY_REGISTERED: 52001,
  MODEL_NOT_FOUND: 52002,
  MODEL_NOT_LOADED: 52003,
  MODEL_IS_DELEGATED: 52004,
  UNKNOWN_MODEL_TYPE: 52005,

  // Model loading (52,200-52,399)
  MODEL_LOAD_FAILED: 52200,
  MODEL_FILE_NOT_FOUND: 52201,
  MODEL_FILE_NOT_FOUND_IN_DIR: 52202,
  MODEL_FILE_LOCATE_FAILED: 52203,
  PROJECTION_MODEL_REQUIRED: 52204,
  VAD_MODEL_REQUIRED: 52205,
  TTS_ARTIFACTS_REQUIRED: 52208,
  TTS_REFERENCE_AUDIO_REQUIRED: 52209,
  LEGACY_PARAKEET_MODEL_DEPRECATED: 52210,
  LEGACY_TTS_MODEL_DEPRECATED: 52211,

  // Model operations (52,400-52,799)
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
  IMAGE_FILE_NOT_FOUND: 52413,
  INVALID_IMAGE_INPUT: 52414,
  TEXT_TO_SPEECH_STREAM_FAILED: 52415,
  MODEL_OPERATION_NOT_SUPPORTED: 52416,
  REQUEST_ID_CONFLICT: 52417,
  REQUEST_NOT_FOUND: 52418,
  INFERENCE_CANCELLED: 52419,
  REQUEST_REJECTED_BY_POLICY: 52420,
  CONTEXT_OVERFLOW: 52421,

  // RAG operations (52,800-52,999)
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

  // Download / resource (53,000-53,199)
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
  REGISTRY_DOWNLOAD_FAILED: 53015,

  // Cache operations (53,200-53,349)
  DELETE_CACHE_FAILED: 53200,
  INVALID_DELETE_CACHE_PARAMS: 53201,
  CACHE_DIR_NOT_ABSOLUTE: 53202,
  CACHE_DIR_NOT_WRITABLE: 53203,

  // Config operations (53,350-53,499)
  CONFIG_ALREADY_SET: 53351,

  // Lifecycle (53,600-53,610)
  LIFECYCLE_SUSPEND_FAILED: 53600,
  LIFECYCLE_RESUME_FAILED: 53601,
  LIFECYCLE_OPERATION_BLOCKED: 53602,

  // System / runtime (53,500-53,699)
  FFMPEG_NOT_AVAILABLE: 53500,
  AUDIO_PLAYER_FAILED: 53501,
  INVALID_AUDIO_CHUNK_TYPE: 53502,
  ASYNC_DISPOSE_UNAVAILABLE: 53503,

  // Delegation, provider side (53,700-53,849)
  DELEGATE_NO_FINAL_RESPONSE: 53700,
  DELEGATE_CONNECTION_FAILED: 53701,
  DELEGATE_PROVIDER_ERROR: 53702,
  RPC_NO_DATA_RECEIVED: 53703,
  RPC_UNKNOWN_REQUEST_TYPE: 53704,

  // Plugin errors (53,850-53,899)
  PLUGIN_NOT_FOUND: 53850,
  PLUGIN_HANDLER_NOT_FOUND: 53851,
  PLUGIN_REQUEST_VALIDATION_FAILED: 53852,
  PLUGIN_RESPONSE_VALIDATION_FAILED: 53853,
  PLUGIN_ALREADY_REGISTERED: 53854,
  PLUGIN_HANDLER_TYPE_MISMATCH: 53855,
  PLUGIN_LOGGING_INVALID: 53856,
  PLUGIN_DEFINITION_INVALID: 53857,
  PLUGIN_MODEL_TYPE_RESERVED: 53858,
  PLUGIN_LOAD_CONFIG_VALIDATION_FAILED: 53859,

  // Security (53,900-53,949)
  PATH_TRAVERSAL: 53900,

  // Model registry query (53,950-54,000)
  QVAC_MODEL_REGISTRY_QUERY_FAILED: 53950
} as const

const errorDefinitions: ErrorCodesMap = {
  // Response / request validation
  [ERROR_CODES.INVALID_RESPONSE_TYPE]: {
    name: 'INVALID_RESPONSE_TYPE',
    message: (expected: string) => `Invalid response type received, expected: ${expected}`
  },
  [ERROR_CODES.INVALID_OPERATION_IN_RESPONSE]: {
    name: 'INVALID_OPERATION_IN_RESPONSE',
    message: 'Invalid operation type in response'
  },
  [ERROR_CODES.STREAM_ENDED_WITHOUT_RESPONSE]: {
    name: 'STREAM_ENDED_WITHOUT_RESPONSE',
    message: 'Stream ended without receiving final response'
  },
  [ERROR_CODES.INVALID_TOOLS_ARRAY]: {
    name: 'INVALID_TOOLS_ARRAY',
    message: 'Invalid tools array provided'
  },
  [ERROR_CODES.INVALID_TOOL_SCHEMA]: {
    name: 'INVALID_TOOL_SCHEMA',
    message: (details: string) => `Invalid tool schema: ${details}`
  },
  [ERROR_CODES.MODEL_TYPE_REQUIRED]: {
    name: 'MODEL_TYPE_REQUIRED',
    message:
      'modelType is required: modelSrc is a plain string or lacks an engine/addon descriptor that can be inferred. Pass an explicit canonical modelType (e.g. "llamacpp-completion", "whispercpp-transcription", "nmtcpp-translation", "llamacpp-embedding", "tts-ggml", "ggml-ocr", "parakeet-transcription", "sdcpp-generation") or use a model constant that carries engine metadata.'
  },
  [ERROR_CODES.MODEL_SRC_TYPE_MISMATCH]: {
    name: 'MODEL_SRC_TYPE_MISMATCH',
    message: (inferred: string, resolved: string) =>
      `modelSrc describes "${inferred}", but modelType resolves to "${resolved}". Omit modelType to infer it automatically, or pass a matching modelType.`
  },
  [ERROR_CODES.REQUEST_VALIDATION_FAILED]: {
    name: 'REQUEST_VALIDATION_FAILED',
    message: (errors: string) => `Invalid request:\n${errors}`
  },

  // Dispatch
  [ERROR_CODES.RPC_NO_HANDLER]: {
    name: 'RPC_NO_HANDLER',
    message: (requestType: string) =>
      `No handler function registered for request type: ${requestType}`
  },

  // Provider / delegation, consumer side
  [ERROR_CODES.PROVIDER_START_FAILED]: {
    name: 'PROVIDER_START_FAILED',
    message: (details?: string) => `Failed to start provider${details ? `: ${details}` : ''}`
  },
  [ERROR_CODES.PROVIDER_STOP_FAILED]: {
    name: 'PROVIDER_STOP_FAILED',
    message: (details?: string) => `Failed to stop provider${details ? `: ${details}` : ''}`
  },

  // Config file resolution
  [ERROR_CODES.CONFIG_FILE_INVALID]: {
    name: 'CONFIG_FILE_INVALID',
    message: (filePath: string, reason: string) =>
      `Config file at ${filePath} is invalid: ${reason}`
  },
  [ERROR_CODES.CONFIG_FILE_PARSE_FAILED]: {
    name: 'CONFIG_FILE_PARSE_FAILED',
    message: (filePath: string, error: string) =>
      `Failed to parse config file at ${filePath}: ${error}`
  },
  [ERROR_CODES.CONFIG_VALIDATION_FAILED]: {
    name: 'CONFIG_VALIDATION_FAILED',
    message: (errors: string) => `Config validation failed: ${errors}`
  },
  [ERROR_CODES.PLUGINS_NOT_REGISTERED]: {
    name: 'PLUGINS_NOT_REGISTERED',
    message: () =>
      'No plugins registered. Assemble the engines you need with `plugins([...])` or `registerPlugin(...)` before your first call — import each from its subpath, e.g. `@qvac/core/llamacpp-completion/plugin`.'
  },

  // Profiler
  [ERROR_CODES.PROFILER_INVALID_CAPACITY]: {
    name: 'PROFILER_INVALID_CAPACITY',
    message: (minCapacity: number) => `Ring buffer capacity must be at least ${minCapacity}`
  },

  // Model registry
  [ERROR_CODES.MODEL_ALREADY_REGISTERED]: {
    name: 'MODEL_ALREADY_REGISTERED',
    message: (modelId: string) => `Model with ID "${modelId}" is already registered`
  },
  [ERROR_CODES.MODEL_NOT_FOUND]: {
    name: 'MODEL_NOT_FOUND',
    message: (modelId: string) => `Model with ID "${modelId}" not found`
  },
  [ERROR_CODES.MODEL_NOT_LOADED]: {
    name: 'MODEL_NOT_LOADED',
    message: (modelId: string) => `Model with ID "${modelId}" is not loaded`
  },
  [ERROR_CODES.MODEL_IS_DELEGATED]: {
    name: 'MODEL_IS_DELEGATED',
    message: (modelId: string) =>
      `Model "${modelId}" is a delegated model and cannot be accessed directly`
  },
  [ERROR_CODES.UNKNOWN_MODEL_TYPE]: {
    name: 'UNKNOWN_MODEL_TYPE',
    message: (modelType: string) =>
      `Unknown model type: ${modelType}. Register the plugin for "${modelType}" in code with \`registerPlugin\` / \`plugins([...])\` before this call.`
  },

  // Model loading
  [ERROR_CODES.MODEL_LOAD_FAILED]: {
    name: 'MODEL_LOAD_FAILED',
    message: (details?: string) => `Failed to load model${details ? `: ${details}` : ''}`
  },
  [ERROR_CODES.MODEL_FILE_NOT_FOUND]: {
    name: 'MODEL_FILE_NOT_FOUND',
    message: (modelPath: string) => `Model file not found: ${modelPath}`
  },
  [ERROR_CODES.MODEL_FILE_NOT_FOUND_IN_DIR]: {
    name: 'MODEL_FILE_NOT_FOUND_IN_DIR',
    message: (modelFile: string, modelDir: string, modelType: string) =>
      `${modelType} model file ${modelFile} not found in directory ${modelDir}`
  },
  [ERROR_CODES.MODEL_FILE_LOCATE_FAILED]: {
    name: 'MODEL_FILE_LOCATE_FAILED',
    message: (modelType: string, modelPath: string) =>
      `Failed to locate ${modelType} model file: ${modelPath}`
  },
  [ERROR_CODES.PROJECTION_MODEL_REQUIRED]: {
    name: 'PROJECTION_MODEL_REQUIRED',
    message: 'Projection model source is required for multimodal LLM models'
  },
  [ERROR_CODES.VAD_MODEL_REQUIRED]: {
    name: 'VAD_MODEL_REQUIRED',
    message: 'VAD model source is required for this configuration'
  },
  [ERROR_CODES.TTS_ARTIFACTS_REQUIRED]: {
    name: 'TTS_ARTIFACTS_REQUIRED',
    message:
      'TTS (Chatterbox) requires s3genModelSrc in modelConfig (companion S3Gen GGUF) and the primary T3 GGUF via modelSrc'
  },
  [ERROR_CODES.TTS_REFERENCE_AUDIO_REQUIRED]: {
    name: 'TTS_REFERENCE_AUDIO_REQUIRED',
    message:
      'TTS (Chatterbox) requires referenceAudioSrc (path or URL to a WAV file for voice cloning)'
  },
  [ERROR_CODES.LEGACY_PARAKEET_MODEL_DEPRECATED]: {
    name: 'LEGACY_PARAKEET_MODEL_DEPRECATED',
    message: (legacyFields?: string) =>
      `Legacy parakeet ONNX modelConfig fields are no longer supported (${legacyFields ?? 'unknown fields'}). As of @qvac/transcription-parakeet 0.6.0 the addon ships as a single GGUF that auto-detects TDT / CTC / EOU / Sortformer from GGUF metadata. Supply the GGUF via the top-level modelSrc (e.g. loadModel({ modelSrc: PARAKEET_TDT_0_6B_V3_Q8_0, modelType: "parakeet" })).`
  },
  [ERROR_CODES.LEGACY_TTS_MODEL_DEPRECATED]: {
    name: 'LEGACY_TTS_MODEL_DEPRECATED',
    message: (legacyFields?: string) =>
      `Legacy ONNX TTS modelConfig fields are no longer supported (${legacyFields ?? 'unknown fields'}). As of @qvac/tts-ggml the addon uses GGUF bundles: supply the primary GGUF via modelSrc, set language in modelConfig, and for Chatterbox add s3genModelSrc (e.g. loadModel({ modelSrc: TTS_T3_TURBO_EN_CHATTERBOX_Q8_0, modelType: "tts", modelConfig: { ttsEngine: "chatterbox", language: "en", s3genModelSrc: TTS_S3GEN_EN_CHATTERBOX } })). Supertonic multilingual mode is selected by the GGUF (e.g. TTS_MULTILINGUAL_SUPERTONIC2_Q8_0) plus language — not ttsSupertonicMultilingual.`
  },

  // Model operations
  [ERROR_CODES.MODEL_UNLOAD_FAILED]: {
    name: 'MODEL_UNLOAD_FAILED',
    message: (modelId?: string) => `Failed to unload model${modelId ? ` "${modelId}"` : ''}`
  },
  [ERROR_CODES.EMBED_FAILED]: {
    name: 'EMBED_FAILED',
    message: (details?: string) => `Failed to generate embeddings${details ? `: ${details}` : ''}`
  },
  [ERROR_CODES.EMBED_NO_EMBEDDINGS]: {
    name: 'EMBED_NO_EMBEDDINGS',
    message: 'No embeddings returned from model'
  },
  [ERROR_CODES.TRANSCRIPTION_FAILED]: {
    name: 'TRANSCRIPTION_FAILED',
    message: (details?: string) => `Transcription failed${details ? `: ${details}` : ''}`
  },
  [ERROR_CODES.AUDIO_FILE_NOT_FOUND]: {
    name: 'AUDIO_FILE_NOT_FOUND',
    message: (filePath: string) => `Audio file not found or not accessible: ${filePath}`
  },
  [ERROR_CODES.TRANSLATION_FAILED]: {
    name: 'TRANSLATION_FAILED',
    message: (details?: string) => `Translation failed${details ? `: ${details}` : ''}`
  },
  [ERROR_CODES.COMPLETION_FAILED]: {
    name: 'COMPLETION_FAILED',
    message: (details?: string) => `Completion failed${details ? `: ${details}` : ''}`
  },
  [ERROR_CODES.ATTACHMENT_NOT_FOUND]: {
    name: 'ATTACHMENT_NOT_FOUND',
    message: (path: string) => `Attachment not found at path: ${path}`
  },
  [ERROR_CODES.CANCEL_FAILED]: {
    name: 'CANCEL_FAILED',
    message: (details?: string) => `Failed to cancel operation${details ? `: ${details}` : ''}`
  },
  [ERROR_CODES.TEXT_TO_SPEECH_FAILED]: {
    name: 'TEXT_TO_SPEECH_FAILED',
    message: (details?: string) => `Text-to-speech operation failed${details ? `: ${details}` : ''}`
  },
  [ERROR_CODES.CONFIG_RELOAD_NOT_SUPPORTED]: {
    name: 'CONFIG_RELOAD_NOT_SUPPORTED',
    message: (modelId: string) => `Model "${modelId}" does not support hot config reload`
  },
  [ERROR_CODES.MODEL_TYPE_MISMATCH]: {
    name: 'MODEL_TYPE_MISMATCH',
    message: (expectedType: string, providedType: string) =>
      `Model type mismatch: expected "${expectedType}", got "${providedType}"`
  },
  [ERROR_CODES.IMAGE_FILE_NOT_FOUND]: {
    name: 'IMAGE_FILE_NOT_FOUND',
    message: (filePath: string) => `Image file not found or not accessible: ${filePath}`
  },
  [ERROR_CODES.INVALID_IMAGE_INPUT]: {
    name: 'INVALID_IMAGE_INPUT',
    message: 'Invalid image input type provided'
  },
  [ERROR_CODES.TEXT_TO_SPEECH_STREAM_FAILED]: {
    name: 'TEXT_TO_SPEECH_STREAM_FAILED',
    message: (details?: string) =>
      `Text-to-speech stream operation failed${details ? `: ${details}` : ''}`
  },
  [ERROR_CODES.MODEL_OPERATION_NOT_SUPPORTED]: {
    name: 'MODEL_OPERATION_NOT_SUPPORTED',
    message: (
      modelId: string,
      modelType: string,
      operation: string,
      supportedOperations: string,
      suggestedModelTypes: string
    ) => {
      const supportedClause = supportedOperations
        ? ` Supported operations on this model: ${supportedOperations}.`
        : ' This model does not expose any operations.'
      const suggestionClause = suggestedModelTypes
        ? ` To use ${operation}, load a model of type: ${suggestedModelTypes}.`
        : ` No registered model exposes ${operation}.`
      return `Model "${modelId}" (type: ${modelType}) does not support ${operation}.${supportedClause}${suggestionClause}`
    }
  },
  [ERROR_CODES.REQUEST_ID_CONFLICT]: {
    name: 'REQUEST_ID_CONFLICT',
    message: (requestId: string) =>
      `Request id "${requestId}" is already in flight; refusing to overwrite the existing context`
  },
  [ERROR_CODES.REQUEST_NOT_FOUND]: {
    name: 'REQUEST_NOT_FOUND',
    message: (requestId: string) => `No in-flight request with id "${requestId}"`
  },
  [ERROR_CODES.INFERENCE_CANCELLED]: {
    name: 'INFERENCE_CANCELLED',
    message: (requestId: string) =>
      `Inference request "${requestId}" was cancelled before it could complete`
  },
  [ERROR_CODES.REQUEST_REJECTED_BY_POLICY]: {
    name: 'REQUEST_REJECTED_BY_POLICY',
    message: (requestId: string, kind: string, modelId: string, reason: string) =>
      `Request "${requestId}" (kind: ${kind}, modelId: ${modelId}) was rejected by registry concurrency policy: ${reason}`
  },
  [ERROR_CODES.CONTEXT_OVERFLOW]: {
    name: 'CONTEXT_OVERFLOW',
    message: (promptTokens: string, ctxSize: string, modelId: string) => {
      const prompt = promptTokens ? `${promptTokens} prompt tokens` : 'prompt'
      const ctx = ctxSize
        ? ` exceeds the ${ctxSize}-token context window`
        : " exceeds the model's context window"
      const model = modelId ? ` for model "${modelId}"` : ''
      return `${prompt}${ctx}${model}. Reduce the prompt size or start a new conversation.`
    }
  },

  // RAG operations
  [ERROR_CODES.RAG_SAVE_FAILED]: {
    name: 'RAG_SAVE_FAILED',
    message: (details?: string) => `Failed to save embeddings${details ? `: ${details}` : ''}`
  },
  [ERROR_CODES.RAG_SEARCH_FAILED]: {
    name: 'RAG_SEARCH_FAILED',
    message: (details?: string) => `Failed to search embeddings${details ? `: ${details}` : ''}`
  },
  [ERROR_CODES.RAG_DELETE_FAILED]: {
    name: 'RAG_DELETE_FAILED',
    message: (details?: string) => `Failed to delete embeddings${details ? `: ${details}` : ''}`
  },
  [ERROR_CODES.RAG_UNKNOWN_OPERATION]: {
    name: 'RAG_UNKNOWN_OPERATION',
    message: (operation: string) => `Unknown RAG operation: ${operation}`
  },
  [ERROR_CODES.RAG_HYPERDB_FAILED]: {
    name: 'RAG_HYPERDB_FAILED',
    message: (details: string) => `HyperDB RAG operation failed: ${details}`
  },
  [ERROR_CODES.RAG_WORKSPACE_MODEL_MISMATCH]: {
    name: 'RAG_WORKSPACE_MODEL_MISMATCH',
    message: (workspace: string, existingModelId: string, newModelId: string) =>
      `Workspace "${workspace}" is configured for model "${existingModelId}", but you're trying to use model "${newModelId}". Use a different workspace or the same model`
  },
  [ERROR_CODES.RAG_WORKSPACE_NOT_FOUND]: {
    name: 'RAG_WORKSPACE_NOT_FOUND',
    message: (workspace: string) => `RAG workspace not found: ${workspace}`
  },
  [ERROR_CODES.RAG_WORKSPACE_IN_USE]: {
    name: 'RAG_WORKSPACE_IN_USE',
    message: (workspace: string) =>
      `RAG workspace '${workspace}' is currently in use. Close it first.`
  },
  [ERROR_CODES.RAG_WORKSPACE_CLOSE_FAILED]: {
    name: 'RAG_WORKSPACE_CLOSE_FAILED',
    message: (details?: string) => `Failed to close RAG workspace${details ? `: ${details}` : ''}`
  },
  [ERROR_CODES.RAG_LIST_WORKSPACES_FAILED]: {
    name: 'RAG_LIST_WORKSPACES_FAILED',
    message: (details?: string) => `Failed to list RAG workspaces${details ? `: ${details}` : ''}`
  },
  [ERROR_CODES.RAG_CHUNK_FAILED]: {
    name: 'RAG_CHUNK_FAILED',
    message: (details?: string) => `Failed to chunk documents${details ? `: ${details}` : ''}`
  },
  [ERROR_CODES.RAG_WORKSPACE_NOT_OPEN]: {
    name: 'RAG_WORKSPACE_NOT_OPEN',
    message: (workspace: string) => `RAG workspace '${workspace}' is not open`
  },

  // Download / resource
  [ERROR_CODES.FILE_NOT_FOUND]: {
    name: 'FILE_NOT_FOUND',
    message: (path: string) => `File not found: ${path}`
  },
  [ERROR_CODES.DOWNLOAD_CANCELLED]: {
    name: 'DOWNLOAD_CANCELLED',
    message: 'Download was cancelled'
  },
  [ERROR_CODES.CHECKSUM_VALIDATION_FAILED]: {
    name: 'CHECKSUM_VALIDATION_FAILED',
    message: (fileName: string) => `Checksum validation failed for ${fileName}`
  },
  [ERROR_CODES.HTTP_ERROR]: {
    name: 'HTTP_ERROR',
    message: (status: number, statusText: string) => `HTTP error: ${status} ${statusText}`
  },
  [ERROR_CODES.NO_RESPONSE_BODY]: {
    name: 'NO_RESPONSE_BODY',
    message: 'No response body received from HTTP request'
  },
  [ERROR_CODES.RESPONSE_BODY_NOT_READABLE]: {
    name: 'RESPONSE_BODY_NOT_READABLE',
    message: 'Response body is not readable'
  },
  [ERROR_CODES.NO_BLOB_FOUND]: {
    name: 'NO_BLOB_FOUND',
    message: (fileName: string) => `No blob found for ${fileName}`
  },
  [ERROR_CODES.DOWNLOAD_ASSET_FAILED]: {
    name: 'DOWNLOAD_ASSET_FAILED',
    message: (details?: string) => `Failed to download asset${details ? `: ${details}` : ''}`
  },
  [ERROR_CODES.SEEDING_NOT_SUPPORTED]: {
    name: 'SEEDING_NOT_SUPPORTED',
    message: 'Seeding is only supported for hyperdrive models'
  },
  [ERROR_CODES.HYPERDRIVE_DOWNLOAD_FAILED]: {
    name: 'HYPERDRIVE_DOWNLOAD_FAILED',
    message: (details: string) => `Hyperdrive download failed: ${details}`
  },
  [ERROR_CODES.REGISTRY_DOWNLOAD_FAILED]: {
    name: 'REGISTRY_DOWNLOAD_FAILED',
    message: (details: string) => `Registry download failed: ${details}`
  },
  [ERROR_CODES.INVALID_SHARD_URL_PATTERN]: {
    name: 'INVALID_SHARD_URL_PATTERN',
    message: (url: string) => `URL does not contain a valid sharded model pattern: ${url}`
  },
  [ERROR_CODES.ARCHIVE_EXTRACTION_FAILED]: {
    name: 'ARCHIVE_EXTRACTION_FAILED',
    message: (archivePath: string) => `Failed to extract archive: ${archivePath}`
  },
  [ERROR_CODES.ARCHIVE_UNSUPPORTED_TYPE]: {
    name: 'ARCHIVE_UNSUPPORTED_TYPE',
    message: (archivePath: string) => `Unsupported archive type: ${archivePath}`
  },
  [ERROR_CODES.ARCHIVE_MISSING_SHARDS]: {
    name: 'ARCHIVE_MISSING_SHARDS',
    message: (missingFile: string) => `Archive is missing required shard file: ${missingFile}`
  },
  [ERROR_CODES.PARTIAL_DOWNLOAD_OFFLINE]: {
    name: 'PARTIAL_DOWNLOAD_OFFLINE',
    message: (url: string, downloadedBytes: string) =>
      `Cannot resume partial download (${downloadedBytes} bytes downloaded) - unable to connect. URL: ${url}`
  },

  // Cache operations
  [ERROR_CODES.DELETE_CACHE_FAILED]: {
    name: 'DELETE_CACHE_FAILED',
    message: (details?: string) => `Failed to delete cache${details ? `: ${details}` : ''}`
  },
  [ERROR_CODES.INVALID_DELETE_CACHE_PARAMS]: {
    name: 'INVALID_DELETE_CACHE_PARAMS',
    message: 'Invalid deleteCache parameters - provide either modelId or cacheKey'
  },
  [ERROR_CODES.CACHE_DIR_NOT_ABSOLUTE]: {
    name: 'CACHE_DIR_NOT_ABSOLUTE',
    message: 'Cache directory must be an absolute path'
  },
  [ERROR_CODES.CACHE_DIR_NOT_WRITABLE]: {
    name: 'CACHE_DIR_NOT_WRITABLE',
    message: (cacheDir: string, details?: string) =>
      `Cache directory is not writable: ${cacheDir}${details ? `. ${details}` : ''}`
  },

  // Config operations
  [ERROR_CODES.CONFIG_ALREADY_SET]: {
    name: 'CONFIG_ALREADY_SET',
    message:
      'Config has already been set and is immutable. Config can only be set once during initialization.'
  },

  // Lifecycle
  [ERROR_CODES.LIFECYCLE_SUSPEND_FAILED]: {
    name: 'LIFECYCLE_SUSPEND_FAILED',
    message: (details?: string) => `Runtime suspend failed${details ? `: ${details}` : ''}`
  },
  [ERROR_CODES.LIFECYCLE_RESUME_FAILED]: {
    name: 'LIFECYCLE_RESUME_FAILED',
    message: (details?: string) => `Runtime resume failed${details ? `: ${details}` : ''}`
  },
  [ERROR_CODES.LIFECYCLE_OPERATION_BLOCKED]: {
    name: 'LIFECYCLE_OPERATION_BLOCKED',
    message: (requestType: string, lifecycleState: string) =>
      `Operation "${requestType}" is blocked while runtime state is "${lifecycleState}"`
  },

  // System / runtime
  [ERROR_CODES.FFMPEG_NOT_AVAILABLE]: {
    name: 'FFMPEG_NOT_AVAILABLE',
    message: 'FFmpeg is not available on this system'
  },
  [ERROR_CODES.AUDIO_PLAYER_FAILED]: {
    name: 'AUDIO_PLAYER_FAILED',
    message: (details: string) => `Audio player failed: ${details}`
  },
  [ERROR_CODES.INVALID_AUDIO_CHUNK_TYPE]: {
    name: 'INVALID_AUDIO_CHUNK_TYPE',
    message: 'Invalid audio chunk type'
  },
  [ERROR_CODES.ASYNC_DISPOSE_UNAVAILABLE]: {
    name: 'ASYNC_DISPOSE_UNAVAILABLE',
    message:
      'Host runtime does not expose Symbol.asyncDispose; core request-lifecycle primitives require ES2024 `using`/`asyncDispose` support. Verify your runtime (Bare ≥ 1.24) and any polyfill registration.'
  },

  // Delegation, provider side
  [ERROR_CODES.DELEGATE_NO_FINAL_RESPONSE]: {
    name: 'DELEGATE_NO_FINAL_RESPONSE',
    message: 'No final response received from delegated provider'
  },
  [ERROR_CODES.DELEGATE_CONNECTION_FAILED]: {
    name: 'DELEGATE_CONNECTION_FAILED',
    message: (details: string) => `Failed to connect to delegated provider: ${details}`
  },
  [ERROR_CODES.DELEGATE_PROVIDER_ERROR]: {
    name: 'DELEGATE_PROVIDER_ERROR',
    message: (details: string, providerCode?: string) =>
      `Delegated provider error: ${details}` + (providerCode ? ` (code: ${providerCode})` : '')
  },
  [ERROR_CODES.RPC_NO_DATA_RECEIVED]: {
    name: 'RPC_NO_DATA_RECEIVED',
    message: 'No data received from request'
  },
  [ERROR_CODES.RPC_UNKNOWN_REQUEST_TYPE]: {
    name: 'RPC_UNKNOWN_REQUEST_TYPE',
    message: (requestType: string) => `Unknown request type received: ${requestType}`
  },

  // Plugin errors
  [ERROR_CODES.PLUGIN_NOT_FOUND]: {
    name: 'PLUGIN_NOT_FOUND',
    message: (modelType: string) =>
      `Plugin not found for model type "${modelType}". Register the plugin in code with \`registerPlugin\` / \`plugins([...])\` before this call.`
  },
  [ERROR_CODES.PLUGIN_HANDLER_NOT_FOUND]: {
    name: 'PLUGIN_HANDLER_NOT_FOUND',
    message: (modelType: string, handler: string, availableHandlers?: string) =>
      `Handler "${handler}" not found in plugin "${modelType}"` +
      (availableHandlers ? `. Available handlers: ${availableHandlers}` : '')
  },
  [ERROR_CODES.PLUGIN_REQUEST_VALIDATION_FAILED]: {
    name: 'PLUGIN_REQUEST_VALIDATION_FAILED',
    message: (handler: string, details?: string) =>
      `Request validation failed for handler "${handler}"${details ? `: ${details}` : ''}`
  },
  [ERROR_CODES.PLUGIN_RESPONSE_VALIDATION_FAILED]: {
    name: 'PLUGIN_RESPONSE_VALIDATION_FAILED',
    message: (handler: string, details?: string) =>
      `Response validation failed for handler "${handler}"${details ? `: ${details}` : ''}`
  },
  [ERROR_CODES.PLUGIN_ALREADY_REGISTERED]: {
    name: 'PLUGIN_ALREADY_REGISTERED',
    message: (modelType: string) => `Plugin already registered for modelType: ${modelType}`
  },
  [ERROR_CODES.PLUGIN_HANDLER_TYPE_MISMATCH]: {
    name: 'PLUGIN_HANDLER_TYPE_MISMATCH',
    message: (handlerName: string, expected: string, actual: string) =>
      `Handler "${handlerName}" is ${actual}, but was called as ${expected}. Use invokePlugin() for reply handlers and invokePluginStream() for streaming handlers.`
  },
  [ERROR_CODES.PLUGIN_LOGGING_INVALID]: {
    name: 'PLUGIN_LOGGING_INVALID',
    message: (modelType: string, reason: string) =>
      `Plugin "${modelType}" has invalid logging configuration: ${reason}`
  },
  [ERROR_CODES.PLUGIN_DEFINITION_INVALID]: {
    name: 'PLUGIN_DEFINITION_INVALID',
    message: (modelType: string, details: string) =>
      `Plugin definition invalid for "${modelType}": ${details}`
  },
  [ERROR_CODES.PLUGIN_MODEL_TYPE_RESERVED]: {
    name: 'PLUGIN_MODEL_TYPE_RESERVED',
    message: (modelType: string) => `modelType "${modelType}" is reserved for built-in plugins`
  },
  [ERROR_CODES.PLUGIN_LOAD_CONFIG_VALIDATION_FAILED]: {
    name: 'PLUGIN_LOAD_CONFIG_VALIDATION_FAILED',
    message: (modelType: string, details: string) =>
      `modelConfig validation failed for "${modelType}": ${details}`
  },

  // Security
  [ERROR_CODES.PATH_TRAVERSAL]: {
    name: 'PATH_TRAVERSAL',
    message: (component: string, basePath: string) =>
      `Path traversal detected: "${component}" escapes base directory "${basePath}"`
  },

  // Model registry query
  [ERROR_CODES.QVAC_MODEL_REGISTRY_QUERY_FAILED]: {
    name: 'QVAC_MODEL_REGISTRY_QUERY_FAILED',
    message: (details?: string) =>
      `QVAC model registry query failed${details ? `: ${details}` : ''}`
  }
}

addCodes(errorDefinitions, { name: 'qvac-core', version: '1.0.0' })

export { errorDefinitions as ERROR_DEFINITIONS }

// Registry client error codes (19,001-20,000 range). These match the codes
// from @qvac/registry-client; the actual definitions live in that package.
export const REGISTRY_ERROR_CODES = {
  FAILED_TO_CONNECT: 19001,
  FAILED_TO_CLOSE: 19002,
  MODEL_NOT_FOUND: 19003
} as const
