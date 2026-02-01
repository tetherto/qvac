import { getRagInstance } from "@/server/bare/rag-hyperdb/rag-manager";
import { embed } from "@/server/bare/addons/llamacpp";
import {
  type RagSaveEmbeddingsParams,
  ragSaveEmbeddingsOperationSchema,
} from "@/schemas";
import type { SaveEmbeddingsOpts } from "@qvac/rag";

export async function saveEmbeddings(params: RagSaveEmbeddingsParams) {
  const { modelId, documents, chunk, chunkOpts, workspace } =
    ragSaveEmbeddingsOperationSchema.parse(params);

  const embeddingFunction = async (text: string) => {
    return await embed({ modelId, text });
  };

  const rag = await getRagInstance(modelId, embeddingFunction, workspace);

  const saveOpts: SaveEmbeddingsOpts = { chunk };
  if (chunkOpts) {
    saveOpts.chunkOpts = chunkOpts;
  }

  const result = await rag.saveEmbeddings(documents, saveOpts);
  return result;
}
