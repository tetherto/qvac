import { getRagDbAdapter, hasRagWorkspaceStorage } from '../rag-workspace-manager'
import { ragDeleteEmbeddingsParamsSchema, type RagDeleteEmbeddingsParams } from '../../../schemas'
import { RAGDeleteFailedError } from '../../../errors'

export async function deleteEmbeddings(params: RagDeleteEmbeddingsParams) {
  const { ids, workspace } = ragDeleteEmbeddingsParamsSchema.parse(params)

  if (!hasRagWorkspaceStorage(workspace)) {
    throw new RAGDeleteFailedError('workspace is not initialized')
  }

  const dbAdapter = await getRagDbAdapter(workspace)

  await dbAdapter.deleteEmbeddings(ids)
}
