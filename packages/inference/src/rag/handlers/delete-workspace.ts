import { deleteWorkspace as deleteWorkspaceFromManager } from '@/rag/rag-workspace-manager'
import { ragDeleteWorkspaceParamsSchema, type RagDeleteWorkspaceParams } from '@/schemas/index'
import { RAGWorkspaceNotFoundError } from '@/errors/index'

export async function deleteWorkspace(params: RagDeleteWorkspaceParams) {
  const { workspace } = ragDeleteWorkspaceParamsSchema.parse(params)

  const deleted = await deleteWorkspaceFromManager(workspace)

  if (!deleted) {
    throw new RAGWorkspaceNotFoundError(workspace)
  }
}
