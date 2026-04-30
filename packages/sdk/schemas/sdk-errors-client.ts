import { addCodes, type ErrorCodesMap } from "@qvac/error";

// Client-side error codes (50,001-52,000 range for this SDK)
export const SDK_CLIENT_ERROR_CODES = {
  // Response Validation Errors (50,001-50,199)
  INVALID_RESPONSE_TYPE: 50001,
  INVALID_OPERATION_IN_RESPONSE: 50002,
  STREAM_ENDED_WITHOUT_RESPONSE: 50003,
  INVALID_AUDIO_CHUNK_TYPE: 50004,
  INVALID_TOOLS_ARRAY: 50005,
  INVALID_TOOL_SCHEMA: 50006,
  OCR_FAILED: 50007,
  MODEL_TYPE_REQUIRED: 50008,
  MODEL_SRC_TYPE_MISMATCH: 50009,

  // RPC Communication Errors (50,200-50,399)
  RPC_NO_HANDLER: 50200,
  RPC_REQUEST_NOT_SENT: 50201,
  RPC_RESPONSE_STREAM_NOT_CREATED: 50202,
  RPC_CONNECTION_FAILED: 50203,
  RPC_INIT_TIMEOUT: 50204,

  // Provider/Delegation Errors (50,400-50,599)
  PROVIDER_START_FAILED: 50400,
  PROVIDER_STOP_FAILED: 50401,
  DELEGATE_NO_FINAL_RESPONSE: 50402,
  DELEGATE_PROVIDER_ERROR: 50403,
  DELEGATE_CONNECTION_FAILED: 50404,

  // Build/Bundle Errors (50,600-50,799)
  SDK_NOT_FOUND_IN_NODE_MODULES: 50600,
  WORKER_FILE_NOT_FOUND: 50601,

  CONFIG_FILE_NOT_FOUND: 50602,
  CONFIG_FILE_INVALID: 50603,
  CONFIG_FILE_PARSE_FAILED: 50604,
  CONFIG_VALIDATION_FAILED: 50605,
  PEAR_WORKER_ENTRY_REQUIRED: 50606,
  MULTIPLE_SDK_INSTALLATIONS: 50607,

  // Profiler Errors (50,800-50,899)
  PROFILER_INVALID_CAPACITY: 50800,
} as const;

const clientErrorDefinitions: ErrorCodesMap = {
  // Response Validation Errors (50,001-50,199)
  [SDK_CLIENT_ERROR_CODES.INVALID_RESPONSE_TYPE]: {
    name: "INVALID_RESPONSE_TYPE",
    message: (expected: string) =>
      `Invalid response type received, expected: ${expected}`,
  },
  [SDK_CLIENT_ERROR_CODES.INVALID_OPERATION_IN_RESPONSE]: {
    name: "INVALID_OPERATION_IN_RESPONSE",
    message: "Invalid operation type in response",
  },
  [SDK_CLIENT_ERROR_CODES.STREAM_ENDED_WITHOUT_RESPONSE]: {
    name: "STREAM_ENDED_WITHOUT_RESPONSE",
    message: "Stream ended without receiving final response",
  },
  [SDK_CLIENT_ERROR_CODES.INVALID_AUDIO_CHUNK_TYPE]: {
    name: "INVALID_AUDIO_CHUNK_TYPE",
    message: "Invalid audio chunk type received",
  },
  [SDK_CLIENT_ERROR_CODES.INVALID_TOOLS_ARRAY]: {
    name: "INVALID_TOOLS_ARRAY",
    message: "Invalid tools array provided",
  },
  [SDK_CLIENT_ERROR_CODES.INVALID_TOOL_SCHEMA]: {
    name: "INVALID_TOOL_SCHEMA",
    message: (details: string) => `Invalid tool schema: ${details}`,
  },
  [SDK_CLIENT_ERROR_CODES.OCR_FAILED]: {
    name: "OCR_FAILED",
    message: (details?: string) =>
      `OCR operation failed${details ? `: ${details}` : ""}`,
  },
  [SDK_CLIENT_ERROR_CODES.MODEL_TYPE_REQUIRED]: {
    name: "MODEL_TYPE_REQUIRED",
    message:
      'modelType is required: modelSrc is a plain string or lacks an engine/addon descriptor that can be inferred. Pass an explicit canonical modelType (e.g. "llamacpp-completion", "whispercpp-transcription", "nmtcpp-translation", "llamacpp-embedding", "onnx-tts", "onnx-ocr", "parakeet-transcription", "sdcpp-generation") or use a model constant that carries engine metadata.',
  },
  [SDK_CLIENT_ERROR_CODES.MODEL_SRC_TYPE_MISMATCH]: {
    name: "MODEL_SRC_TYPE_MISMATCH",
    message: (inferred: string, resolved: string) =>
      `modelSrc describes "${inferred}", but modelType resolves to "${resolved}". Omit modelType to infer it automatically, or pass a matching modelType.`,
  },

  // RPC Communication Errors (50,200-50,399)
  [SDK_CLIENT_ERROR_CODES.RPC_NO_HANDLER]: {
    name: "RPC_NO_HANDLER",
    message: (requestType: string) =>
      `No handler function registered for request type: ${requestType}`,
  },
  [SDK_CLIENT_ERROR_CODES.RPC_REQUEST_NOT_SENT]: {
    name: "RPC_REQUEST_NOT_SENT",
    message: "Cannot perform operation - request has not been sent yet",
  },
  [SDK_CLIENT_ERROR_CODES.RPC_RESPONSE_STREAM_NOT_CREATED]: {
    name: "RPC_RESPONSE_STREAM_NOT_CREATED",
    message: "Cannot perform operation - response stream not created",
  },
  [SDK_CLIENT_ERROR_CODES.RPC_CONNECTION_FAILED]: {
    name: "RPC_CONNECTION_FAILED",
    message: (details: string) => `RPC connection failed: ${details}`,
  },
  [SDK_CLIENT_ERROR_CODES.RPC_INIT_TIMEOUT]: {
    name: "RPC_INIT_TIMEOUT",
    message: (timeoutMs: number) =>
      `RPC initialization timed out after ${timeoutMs}ms — the worker process may have failed to start`,
  },

  // Provider/Delegation Errors (50,400-50,599)
  [SDK_CLIENT_ERROR_CODES.PROVIDER_START_FAILED]: {
    name: "PROVIDER_START_FAILED",
    message: (details?: string) =>
      `Failed to start provider${details ? `: ${details}` : ""}`,
  },
  [SDK_CLIENT_ERROR_CODES.PROVIDER_STOP_FAILED]: {
    name: "PROVIDER_STOP_FAILED",
    message: (details?: string) =>
      `Failed to stop provider${details ? `: ${details}` : ""}`,
  },
  [SDK_CLIENT_ERROR_CODES.DELEGATE_NO_FINAL_RESPONSE]: {
    name: "DELEGATE_NO_FINAL_RESPONSE",
    message: "No final response received from delegated provider",
  },
  [SDK_CLIENT_ERROR_CODES.DELEGATE_PROVIDER_ERROR]: {
    name: "DELEGATE_PROVIDER_ERROR",
    message: (details: string) => `Delegated provider error: ${details}`,
  },
  [SDK_CLIENT_ERROR_CODES.DELEGATE_CONNECTION_FAILED]: {
    name: "DELEGATE_CONNECTION_FAILED",
    message: (details: string) =>
      `Failed to connect to delegated provider: ${details}`,
  },

  // Build/Bundle Errors (50,600-50,799)
  [SDK_CLIENT_ERROR_CODES.SDK_NOT_FOUND_IN_NODE_MODULES]: {
    name: "SDK_NOT_FOUND_IN_NODE_MODULES",
    message:
      "QVAC SDK not found in node_modules. Checked: @qvac/sdk, @tetherto/sdk-mono, @tetherto/sdk-dev",
  },
  [SDK_CLIENT_ERROR_CODES.WORKER_FILE_NOT_FOUND]: {
    name: "WORKER_FILE_NOT_FOUND",
    message: (workerPath: string) => `Worker file not found at ${workerPath}`,
  },

  [SDK_CLIENT_ERROR_CODES.CONFIG_FILE_NOT_FOUND]: {
    name: "CONFIG_FILE_NOT_FOUND",
    message: (searchPaths: string) =>
      `Config file not found. Searched: ${searchPaths}. Create qvac.config.json, qvac.config.js, or qvac.config.ts in your project root.`,
  },
  [SDK_CLIENT_ERROR_CODES.CONFIG_FILE_INVALID]: {
    name: "CONFIG_FILE_INVALID",
    message: (filePath: string, reason: string) =>
      `Config file at ${filePath} is invalid: ${reason}`,
  },
  [SDK_CLIENT_ERROR_CODES.CONFIG_FILE_PARSE_FAILED]: {
    name: "CONFIG_FILE_PARSE_FAILED",
    message: (filePath: string, error: string) =>
      `Failed to parse config file at ${filePath}: ${error}`,
  },
  [SDK_CLIENT_ERROR_CODES.CONFIG_VALIDATION_FAILED]: {
    name: "CONFIG_VALIDATION_FAILED",
    message: (errors: string) => `Config validation failed: ${errors}`,
  },
  [SDK_CLIENT_ERROR_CODES.MULTIPLE_SDK_INSTALLATIONS]: {
    name: "MULTIPLE_SDK_INSTALLATIONS",
    message: (packages: string) =>
      `Multiple QVAC SDK installations found: ${packages}. Remove all but one to avoid conflicts.`,
  },
  [SDK_CLIENT_ERROR_CODES.PEAR_WORKER_ENTRY_REQUIRED]: {
    name: "PEAR_WORKER_ENTRY_REQUIRED",
    message: (workerEntry: string) =>
      `No plugins registered. Pear apps must spawn ${workerEntry} as the worker entry. Run \`npx qvac bundle sdk\` to generate it, then spawn the generated file instead of your worker directly.`,
  },

  // Profiler Errors (50,800-50,899)
  [SDK_CLIENT_ERROR_CODES.PROFILER_INVALID_CAPACITY]: {
    name: "PROFILER_INVALID_CAPACITY",
    message: (minCapacity: number) =>
      `Ring buffer capacity must be at least ${minCapacity}`,
  },
};

addCodes(clientErrorDefinitions, { name: "qvac-sdk-client", version: "1.2.0" });

export { clientErrorDefinitions as SDK_CLIENT_ERROR_DEFINITIONS };
