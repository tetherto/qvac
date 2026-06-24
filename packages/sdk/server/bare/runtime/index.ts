export { createDisposableScope } from "@/server/bare/runtime/disposable-scope";
export type { DisposableScope } from "@/server/bare/runtime/disposable-scope";

export type {
  RequestContext,
  RequestKind,
  RequestState,
} from "@/server/bare/runtime/request-context";

export {
  createRequestRegistry,
  getRequestRegistry,
} from "@/server/bare/runtime/request-registry-singleton";
export type {
  BeginOpts,
  CancelByModelId,
  CancelByRequestId,
  CancelTarget,
  ConcurrencyPolicy,
  ManagedRequestContext,
  RequestOutcome,
  RequestRegistry,
} from "@/server/bare/runtime/request-registry";

export { withRequestContext } from "@/server/bare/runtime/with-request-context";
export type { RequestLogContext } from "@/server/bare/runtime/with-request-context";
