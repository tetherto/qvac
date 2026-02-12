import { getRagInstance } from "@/server/bare/rag-hyperdb/rag-workspace-manager";
import { embed } from "@/server/bare/addons/llamacpp-embedding";
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
    return await embed({ modelId, text });
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
