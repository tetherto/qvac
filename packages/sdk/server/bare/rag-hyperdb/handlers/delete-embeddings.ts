import {
  getRagDbAdapter,
  hasRagWorkspaceStorage,
} from "@/server/bare/rag-hyperdb/rag-workspace-manager";
import {
  ragDeleteEmbeddingsParamsSchema,
  type RagDeleteEmbeddingsParams,
} from "@/schemas";
import { RAGDeleteFailedError } from "@/utils/errors-server";

export async function deleteEmbeddings(params: RagDeleteEmbeddingsParams) {
  const { ids, workspace } = ragDeleteEmbeddingsParamsSchema.parse(params);

  if (!hasRagWorkspaceStorage(workspace)) {
    throw new RAGDeleteFailedError("workspace is not initialized");
  }

  const dbAdapter = await getRagDbAdapter(workspace);

  await dbAdapter.deleteEmbeddings(ids);
}
