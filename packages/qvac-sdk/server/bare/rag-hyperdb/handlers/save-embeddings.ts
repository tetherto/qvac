import { getRagDbAdapter } from "@/server/bare/rag-hyperdb/rag-workspace-manager";
import {
  ragSaveEmbeddingsParamsSchema,
  type RagSaveEmbeddingsParams,
} from "@/schemas";
import type { SaveEmbeddingsOpts, SaveStage } from "@qvac/rag";

interface SaveEmbeddingsHandlerOptions {
  onProgress?: (stage: SaveStage, current: number, total: number) => void;
  signal?: AbortSignal;
}

export async function saveEmbeddings(
  params: RagSaveEmbeddingsParams,
  options?: SaveEmbeddingsHandlerOptions,
) {
  const { documents, progressInterval, workspace } =
    ragSaveEmbeddingsParamsSchema.parse(params);

  if (documents.length === 0) {
    return [];
  }

  const dbAdapter = await getRagDbAdapter(workspace);

  const saveOpts: SaveEmbeddingsOpts = {
    progressInterval,
    onProgress: options?.onProgress,
    signal: options?.signal,
  };

  return await dbAdapter.saveEmbeddings(documents, saveOpts);
}
