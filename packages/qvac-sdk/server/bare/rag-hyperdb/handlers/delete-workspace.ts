import {
  isWorkspaceLoaded,
  deleteWorkspace as deleteWorkspaceFromManager,
} from "@/server/bare/rag-hyperdb/rag-workspace-manager";
import {
  ragDeleteWorkspaceParamsSchema,
  type RagDeleteWorkspaceParams,
} from "@/schemas";
import {
  RAGWorkspaceNotFoundError,
  RAGWorkspaceInUseError,
} from "@/utils/errors-server";

export async function deleteWorkspace(params: RagDeleteWorkspaceParams) {
  const { workspace } = ragDeleteWorkspaceParamsSchema.parse(params);

  // Check if workspace is currently in use
  if (isWorkspaceLoaded(workspace)) {
    throw new RAGWorkspaceInUseError(workspace);
  }

  const deleted = await deleteWorkspaceFromManager(workspace);

  if (!deleted) {
    throw new RAGWorkspaceNotFoundError(workspace);
  }
}
