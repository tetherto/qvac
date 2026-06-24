import type { AbortSignal } from "bare-abort-controller";
import type { RagRequest, RagResponse, RagProgressUpdate } from "@/schemas";
import {
  chunk,
  ingest,
  reindex,
  saveEmbeddings,
  search,
  deleteEmbeddings,
  listWorkspaces,
  closeWorkspace,
  deleteWorkspace,
  DEFAULT_WORKSPACE,
  getActiveRagRequest,
  setActiveRagRequest,
  clearActiveRagRequest,
} from "@/server/bare/rag-hyperdb";
import {
  getRequestRegistry,
  withRequestContext,
  type ManagedRequestContext,
} from "@/server/bare/runtime";
import { generateServerRequestId } from "@/server/bare/runtime/request-id";
import { getServerLogger } from "@/logging";
import {
  profileReplyHandler,
  registerOperationMetrics,
} from "@/server/rpc/profiling";

type ProgressOperation = "ingest" | "saveEmbeddings" | "reindex";

interface HandlerOptions {
  onProgress?: (stage: string, current: number, total: number) => void;
  signal?: AbortSignal;
}

registerOperationMetrics<
  { operation?: string; workspace?: string },
  { processed?: unknown[]; results?: unknown[] }
>({
  op: "rag",
  kind: "handler",
  getTags: (req) => {
    const tags: Record<string, string> = {};
    if (req.operation) tags["operation"] = req.operation;
    if (req.workspace) tags["workspace"] = req.workspace;
    return tags;
  },
  fromResult: (res) => {
    const gauges: Record<string, number> = {};
    if (res.processed !== undefined) gauges["processed"] = res.processed.length;
    if (res.results !== undefined) gauges["resultsCount"] = res.results.length;
    return Object.keys(gauges).length > 0 ? gauges : undefined;
  },
});

function createHandlerOptions(
  operation: ProgressOperation,
  workspace: string,
  signal: AbortSignal,
  onProgress?: (update: RagProgressUpdate) => void,
): HandlerOptions {
  const options: HandlerOptions = { signal };

  if (onProgress) {
    options.onProgress = (stage: string, current: number, total: number) =>
      onProgress({
        type: "rag:progress",
        operation,
        workspace,
        stage,
        current,
        total,
        timestamp: Date.now(),
      });
  }

  return options;
}

function omitOnProgress<T extends Record<string, unknown>>(
  obj: T,
): Omit<T, "onProgress" | "withProgress"> {
  const { onProgress, withProgress, ...rest } = obj;
  void onProgress;
  void withProgress;
  return rest;
}

/**
 * Begin a registry-tracked RAG context with workspace-level pre-emption.
 *
 * Workspace-level admission lives in the dispatcher rather than as a
 * registry policy primitive (it's a dispatch concern, not a registry
 * `kind` admission rule). The sequence is **cancel-prior → begin-new**:
 * if another RAG operation is already running on the same workspace,
 * cancel it first, then begin the new context. Reversing the order
 * would cancel the just-installed context.
 *
 * The workspace → requestId map is updated after `begin(...)` succeeds
 * and cleared on scope unwind via `scope.defer(...)`, with a
 * "still mine?" guard so an older op's deferred cleanup cannot stomp
 * a newer op's mapping.
 */
async function beginRagContext(
  workspace: string,
  requestId: string,
): Promise<ManagedRequestContext> {
  const registry = getRequestRegistry();
  const prev = getActiveRagRequest(workspace);
  if (prev !== undefined && prev !== requestId) {
    registry.cancel({ requestId: prev, reason: "rag-workspace-preempt" });
  }
  const ctx = await registry.begin({
    requestId,
    kind: "rag",
  });
  setActiveRagRequest(workspace, requestId);
  ctx.scope.defer(() => {
    clearActiveRagRequest(workspace, requestId);
  });
  return ctx;
}

export async function handleRag(
  request: RagRequest,
  onProgress?: (update: RagProgressUpdate) => void,
): Promise<RagResponse> {
  return profileReplyHandler({ op: "rag", request }, async () =>
    handleRagInternal(request, onProgress),
  );
}

async function handleRagInternal(
  request: RagRequest,
  onProgress?: (update: RagProgressUpdate) => void,
): Promise<RagResponse> {
  switch (request.operation) {
    case "chunk": {
      const chunks = await chunk(request);
      return {
        type: "rag",
        operation: request.operation,
        success: true,
        chunks,
      };
    }

    case "ingest": {
      const workspace = request.workspace ?? DEFAULT_WORKSPACE;
      const requestId = request.requestId ?? generateServerRequestId();
      await using ctx = await beginRagContext(workspace, requestId);
      const log = withRequestContext(getServerLogger(), ctx);
      log.debug("ingest start");
      const handlerOptions = createHandlerOptions(
        "ingest",
        workspace,
        ctx.signal,
        onProgress,
      );
      const params = omitOnProgress(request);
      const result = await ingest(params, handlerOptions);
      return {
        type: "rag",
        operation: request.operation,
        success: true,
        processed: result.processed,
        droppedIndices: result.droppedIndices,
      };
    }

    case "saveEmbeddings": {
      const workspace = request.workspace ?? DEFAULT_WORKSPACE;
      const requestId = request.requestId ?? generateServerRequestId();
      await using ctx = await beginRagContext(workspace, requestId);
      const log = withRequestContext(getServerLogger(), ctx);
      log.debug("saveEmbeddings start");
      const handlerOptions = createHandlerOptions(
        "saveEmbeddings",
        workspace,
        ctx.signal,
        onProgress,
      );
      const params = omitOnProgress(request);
      const processed = await saveEmbeddings(params, handlerOptions);
      return {
        type: "rag",
        operation: request.operation,
        success: true,
        processed,
      };
    }

    case "search": {
      const results = await search(request);
      return {
        type: "rag",
        operation: request.operation,
        success: true,
        results,
      };
    }

    case "deleteEmbeddings": {
      await deleteEmbeddings(request);
      return {
        type: "rag",
        operation: request.operation,
        success: true,
      };
    }

    case "reindex": {
      const workspace = request.workspace ?? DEFAULT_WORKSPACE;
      const requestId = request.requestId ?? generateServerRequestId();
      await using ctx = await beginRagContext(workspace, requestId);
      const log = withRequestContext(getServerLogger(), ctx);
      log.debug("reindex start");
      const handlerOptions = createHandlerOptions(
        "reindex",
        workspace,
        ctx.signal,
        onProgress,
      );
      const params = omitOnProgress(request);
      const result = await reindex(params, handlerOptions);
      return {
        type: "rag",
        operation: request.operation,
        success: true,
        result,
      };
    }

    case "listWorkspaces": {
      const workspaces = listWorkspaces();
      return {
        type: "rag",
        operation: request.operation,
        success: true,
        workspaces,
      };
    }

    case "closeWorkspace": {
      await closeWorkspace(request);
      return {
        type: "rag",
        operation: request.operation,
        success: true,
      };
    }

    case "deleteWorkspace": {
      await deleteWorkspace(request);
      return {
        type: "rag",
        operation: request.operation,
        success: true,
      };
    }
  }
}
