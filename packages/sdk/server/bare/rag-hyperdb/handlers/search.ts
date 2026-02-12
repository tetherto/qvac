import {
  getRagInstance,
  hasRagWorkspaceStorage,
} from "@/server/bare/rag-hyperdb/rag-workspace-manager";
import { embed } from "@/server/bare/addons/llamacpp-embedding";
import { ragSearchParamsSchema, type RagSearchParams } from "@/schemas";

export async function search(params: RagSearchParams) {
  const { modelId, query, topK, n, workspace } =
    ragSearchParamsSchema.parse(params);

  if (!hasRagWorkspaceStorage(workspace)) {
    return [];
  }

  async function embeddingFunction(text: string | string[]) {
    return await embed({ modelId, text });
  }

  const rag = await getRagInstance(modelId, embeddingFunction, workspace);
  const results = await rag.search(query, { topK, n });
  return results;
}
