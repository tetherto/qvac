import {
  getRagDbAdapter,
  hasRagWorkspaceStorage,
} from "@/server/bare/rag-hyperdb/rag-workspace-manager";
import { ragReindexParamsSchema, type RagReindexParams } from "@/schemas";
import type { ReindexOpts, ReindexResult, ReindexStage } from "@qvac/rag";
import { RAGHyperDBFailedError } from "@/utils/errors-server";

interface ReindexHandlerOptions {
  onProgress?: (stage: ReindexStage, current: number, total: number) => void;
  signal?: AbortSignal;
}

export async function reindex(
  params: RagReindexParams,
  options?: ReindexHandlerOptions,
) {
  const { workspace } = ragReindexParamsSchema.parse(params);

  if (!hasRagWorkspaceStorage(workspace)) {
    throw new RAGHyperDBFailedError("workspace is not initialized");
  }

  const dbAdapter = await getRagDbAdapter(workspace);

  const reindexOpts: ReindexOpts = {
    onProgress: options?.onProgress,
    signal: options?.signal,
  };

  const result: ReindexResult = await dbAdapter.reindex(reindexOpts);
  return result;
}
