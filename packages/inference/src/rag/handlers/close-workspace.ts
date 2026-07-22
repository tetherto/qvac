import { closeRagInstance, deleteWorkspace, DEFAULT_WORKSPACE } from '../rag-workspace-manager.ts'
import { ragCloseWorkspaceParamsSchema, type RagCloseWorkspaceParams } from '../../schemas/index.ts'

export async function closeWorkspace(params: RagCloseWorkspaceParams): Promise<void> {
  const { workspace, deleteOnClose } = ragCloseWorkspaceParamsSchema.parse(params)

  await closeRagInstance(workspace)

  if (deleteOnClose) {
    await deleteWorkspace(workspace ?? DEFAULT_WORKSPACE)
  }
}
