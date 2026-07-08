import { type CanonicalModelType } from '../schemas/model-types'

export const RAG_NAMESPACE = 'rag:hyperdb' as const

export type AddonNamespace = CanonicalModelType | typeof RAG_NAMESPACE

// Stream id for the library's own logs.
export const LOG_ID = '__core__'

// Stream id that receives every log, whatever its origin.
export const ALL_LOG_ID = '__all__'

// Namespace stamped on the library's own logs.
export const LOG_NAMESPACE = 'core'
