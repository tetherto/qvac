import { getRequestRegistry } from "@/server/bare/runtime";

// Sentinel for "no workspace specified". Mirrors the value re-exported
// from `rag-workspace-manager.ts`; redeclared locally so this module is
// safely importable in environments that don't have the Bare runtime
// (unit tests, doc generators) — `rag-workspace-manager` pulls in
// `bare-fs` / `bare-path` at module load.
const DEFAULT_WORKSPACE = "default";

/**
 * RAG operation tracking — workspace-level admission bookkeeping.
 *
 * In 0.11.0 the cancel surface for in-flight RAG operations consolidates
 * onto the request registry (`getRequestRegistry().cancel({ requestId })`).
 * The historical workspace-level pre-emption rule — "starting a new
 * `ingest` / `reindex` / `saveEmbeddings` on a workspace cancels any prior
 * op on the same workspace" — is preserved by the dispatcher in
 * `server/rpc/handlers/rag.ts`: the dispatcher cancels the workspace's
 * prior `requestId` (if any) and then begins a new registry context.
 * Workspace-level admission lives in the dispatcher rather than as a
 * registry policy primitive — it's a dispatch concern, not part of the
 * registry's per-`kind` admission rules.
 *
 * This module owns the small workspace → requestId map that makes that
 * pre-emption decision routable from the dispatcher. The map is module-
 * scoped (one per Bare worker) so the dispatcher, the shutdown sweep
 * (`cancelAllRagOperations`), and the workspace-close sweep (which
 * delegates to it via `rag-workspace-manager.ts`) all see the same state.
 */

// workspace key → requestId of the in-flight RAG operation on that workspace.
const activeRagRequestByWorkspace = new Map<string, string>();

export function getWorkspaceKey(workspace?: string): string {
  return workspace ?? DEFAULT_WORKSPACE;
}

/**
 * Returns the `requestId` of any in-flight RAG operation on the workspace
 * (or `undefined` if none). The dispatcher uses this to decide whether to
 * pre-empt before calling `registry.begin(...)`.
 */
export function getActiveRagRequest(workspace?: string): string | undefined {
  return activeRagRequestByWorkspace.get(getWorkspaceKey(workspace));
}

/**
 * Records the `requestId` of a freshly-begun RAG operation. Called by the
 * dispatcher in `rag.ts` after `registry.begin(...)` succeeds; paired with
 * `clearActiveRagRequest` via the request scope's deferred cleanup so the
 * map never outlives the request.
 */
export function setActiveRagRequest(
  workspace: string | undefined,
  requestId: string,
): void {
  activeRagRequestByWorkspace.set(getWorkspaceKey(workspace), requestId);
}

/**
 * Clears the workspace's mapping iff it still belongs to `requestId`. The
 * conditional guard handles the natural race between two ingest calls on
 * the same workspace: the older context's scope unwind must not stomp the
 * newer context's mapping installed by the pre-emption sequence.
 */
export function clearActiveRagRequest(
  workspace: string | undefined,
  requestId: string,
): void {
  const key = getWorkspaceKey(workspace);
  if (activeRagRequestByWorkspace.get(key) === requestId) {
    activeRagRequestByWorkspace.delete(key);
  }
}

/**
 * Shutdown / workspace-close sweep. Cancels every tracked RAG request via
 * the registry and clears the workspace map. Idempotent — callers that
 * re-invoke during a teardown (workspace-close fired twice, shutdown
 * racing with `close-all`) get a no-op on the second pass.
 */
export function cancelAllRagOperations(): void {
  if (activeRagRequestByWorkspace.size === 0) return;
  const registry = getRequestRegistry();
  for (const [key, requestId] of activeRagRequestByWorkspace) {
    registry.cancel({ requestId, reason: "rag-shutdown" });
    activeRagRequestByWorkspace.delete(key);
  }
}
