import { getRagInstance } from "@/server/bare/rag-hyperdb/rag-workspace-manager";
import { embed } from "@/server/bare/ops/embed";
import { ragIngestParamsSchema, type RagIngestParams } from "@/schemas";
import type { IngestOpts, IngestStage } from "@qvac/rag";

interface IngestHandlerOptions {
  onProgress?: (stage: IngestStage, current: number, total: number) => void;
  signal?: AbortSignal;
}

export async function ingest(
  params: RagIngestParams,
  options?: IngestHandlerOptions,
) {
  const { modelId, documents, chunk, chunkOpts, workspace, progressInterval } =
    ragIngestParamsSchema.parse(params);

  async function embeddingFunction(text: string | string[]) {
    const result = await embed({ modelId, text });
    return result.embedding;
  }

  const rag = await getRagInstance(modelId, embeddingFunction, workspace);

  const ingestOpts: IngestOpts = {
    chunk,
    chunkOpts,
    progressInterval,
    onProgress: options?.onProgress,
    signal: options?.signal,
  };

  return await rag.ingest(documents, modelId, ingestOpts);
}
