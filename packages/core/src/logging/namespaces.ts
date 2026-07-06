import { type CanonicalModelType } from '../schemas/model-types'

export const RAG_NAMESPACE = 'rag:hyperdb' as const

export type AddonNamespace = CanonicalModelType | typeof RAG_NAMESPACE

// Reserved ID for core's own (engine) logs
export const CORE_LOG_ID = '__core__'

// Reserved ID for the stream that receives every log
export const CORE_ALL_LOG_ID = '__all__'

// Namespace stamped on core's own logs. Core has no client/server split, so it
// is just "core" (not "sdk:server"). A consumer that wraps core — e.g. the SDK —
// can relabel this at its own forwarding boundary.
export const CORE_NAMESPACE = 'core'
