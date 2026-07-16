import {
  isWorkspaceLoaded,
  deleteWorkspace as deleteWorkspaceFromManager
} from '../rag-workspace-manager.ts'
import {
  ragDeleteWorkspaceParamsSchema,
  type RagDeleteWorkspaceParams
} from '../../schemas/index.ts'
import { RAGWorkspaceNotFoundError, RAGWorkspaceInUseError } from '../../errors/index.ts'

export async function deleteWorkspace(params: RagDeleteWorkspaceParams) {
  const { workspace } = ragDeleteWorkspaceParamsSchema.parse(params)

  // Check if workspace is currently in use
  if (isWorkspaceLoaded(workspace)) {
    throw new RAGWorkspaceInUseError(workspace)
  }

  const deleted = await deleteWorkspaceFromManager(workspace)

  if (!deleted) {
    throw new RAGWorkspaceNotFoundError(workspace)
  }
}
