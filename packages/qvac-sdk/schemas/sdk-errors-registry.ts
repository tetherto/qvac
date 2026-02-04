// Registry client error codes (19,001-20,000 range)
// These match the codes from @tetherto/qvac-lib-registry-client/utils/error.js
// Used for checking error types - the actual error definitions are in the registry client
export const REGISTRY_ERROR_CODES = {
  FAILED_TO_CONNECT: 19001,
  FAILED_TO_CLOSE: 19002,
  MODEL_NOT_FOUND: 19003,
} as const;
