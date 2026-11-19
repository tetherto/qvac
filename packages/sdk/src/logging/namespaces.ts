import { type CanonicalModelType, LOG_ID, ALL_LOG_ID } from '@qvac/inference/surface'

export type AddonNamespace = CanonicalModelType

// Reserved ID for SDK server logs
export const SDK_LOG_ID = LOG_ID

// Reserved ID for the stream that receives all server-side logs
export const SDK_ALL_LOG_ID = ALL_LOG_ID

// Namespace for all SDK server logs
export const SDK_SERVER_NAMESPACE = 'sdk:server'
