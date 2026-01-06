import { getRagInstance } from "@/server/bare/rag-hyperdb/rag-manager";
import { embed } from "@/server/bare/addons/llamacpp";
import {
  type RagDeleteEmbeddingsParams,
  ragDeleteEmbeddingsOperationSchema,
} from "@/schemas";

export async function deleteEmbeddings(params: RagDeleteEmbeddingsParams) {
  const { modelId, ids, workspace } =
    ragDeleteEmbeddingsOperationSchema.parse(params);

  const embeddingFunction = async (text: string) => {
    return await embed({ modelId, text });
  };

  const rag = await getRagInstance(modelId, embeddingFunction, workspace);
  const success = await rag.deleteEmbeddings(ids);
  return success;
}
