import { getRagInstance } from "@/server/bare/rag-hyperdb/rag-manager";
import { embed } from "@/server/bare/addons/llamacpp";
import { type RagSearchParams, ragSearchOperationSchema } from "@/schemas";

export async function search(params: RagSearchParams) {
  const { modelId, query, topK, n, workspace } =
    ragSearchOperationSchema.parse(params);

  const embeddingFunction = async (text: string) => {
    return await embed({ modelId, text });
  };

  const rag = await getRagInstance(modelId, embeddingFunction, workspace);
  const results = await rag.search(query, {
    topK,
    n,
  });
  return results;
}
