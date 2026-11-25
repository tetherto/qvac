import { type CanonicalModelType } from '@/schemas/model-types'

export type AddonNamespace = CanonicalModelType

// Stream id for the library's own logs.
export const LOG_ID = '__engine__'

// Stream id that receives every log, whatever its origin.
export const ALL_LOG_ID = '__all__'

// Namespace stamped on the library's own logs.
export const LOG_NAMESPACE = 'engine'
