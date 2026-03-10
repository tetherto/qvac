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
  registerRagOperation,
  unregisterRagOperation,
} from "@/server/bare/rag-hyperdb";

type ProgressOperation = "ingest" | "saveEmbeddings" | "reindex";

interface HandlerOptions {
  onProgress?: (stage: string, current: number, total: number) => void;
  signal?: AbortSignal;
}

function createHandlerOptions(
  operation: ProgressOperation,
  workspace: string,
  onProgress?: (update: RagProgressUpdate) => void,
): HandlerOptions {
  const signal = registerRagOperation(workspace, operation);

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

export async function handleRag(
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
      const handlerOptions = createHandlerOptions(
        "ingest",
        workspace,
        onProgress,
      );
      const params = omitOnProgress(request);
      try {
        const result = await ingest(params, handlerOptions);
        return {
          type: "rag",
          operation: request.operation,
          success: true,
          processed: result.processed,
          droppedIndices: result.droppedIndices,
        };
      } finally {
        unregisterRagOperation(workspace);
      }
    }

    case "saveEmbeddings": {
      const workspace = request.workspace ?? DEFAULT_WORKSPACE;
      const handlerOptions = createHandlerOptions(
        "saveEmbeddings",
        workspace,
        onProgress,
      );
      const params = omitOnProgress(request);
      try {
        const processed = await saveEmbeddings(params, handlerOptions);
        return {
          type: "rag",
          operation: request.operation,
          success: true,
          processed,
        };
      } finally {
        unregisterRagOperation(workspace);
      }
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
      const handlerOptions = createHandlerOptions(
        "reindex",
        workspace,
        onProgress,
      );
      const params = omitOnProgress(request);
      try {
        const result = await reindex(params, handlerOptions);
        return {
          type: "rag",
          operation: request.operation,
          success: true,
          result,
        };
      } finally {
        unregisterRagOperation(workspace);
      }
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
