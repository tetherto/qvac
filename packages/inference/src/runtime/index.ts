export { createDisposableScope } from '@/runtime/disposable-scope'
export type { DisposableScope } from '@/runtime/disposable-scope'

export type {
  RequestContext,
  RequestKind,
  RequestState,
  RequestLogContext
} from '@/runtime/request-context'
export {
  createRequestRegistry,
  getRequestRegistry,
  withRequestContext
} from '@/runtime/request-context'

export { OWNER_SESSION_ID, resolveSessionId, requestRegistryKey } from '@/runtime/session-id'
export {
  openSession,
  closeSession,
  assertSessionOpen,
  isSessionOpen,
  isOwnerSession,
  listSessions,
  hasOpenSessions,
  clearSessions
} from '@/runtime/session-registry'
export type { SessionEntry } from '@/runtime/session-registry'

export type {
  BeginOpts,
  CancelByModelId,
  CancelByRequestId,
  CancelBySession,
  CancelTarget,
  ConcurrencyPolicy,
  ManagedRequestContext,
  RequestOutcome,
  RequestRegistry
} from '@/runtime/request-registry'
