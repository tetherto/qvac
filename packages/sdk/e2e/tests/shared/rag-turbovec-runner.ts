import { ragCloseWorkspace, ragDeleteWorkspace, ragIngest, ragSearch } from '@qvac/sdk'

export interface RagParams {
  workspace: string
  documentContent?: string
  secondDocumentContent?: string
  documentFile?: string
  searchQuery?: string
  chunkSize: number
  chunkOverlap: number
  chunkStrategy?: string
  adapter?: 'turbovec'
}

interface TurboVecPlatformOperations {
  prepareWorkspace: (workspace: string) => void | Promise<void>
  hasCheckpoint: (workspace: string) => boolean | Promise<boolean>
}

interface RunTurboVecRagOptions extends TurboVecPlatformOperations {
  params: RagParams
  content: string
  embeddingModelId: string
  workspace: string
}

export function getRagWorkspaceName(params: RagParams, embeddingModelId: string) {
  const workspaceSuffix =
    params.adapter === 'turbovec'
      ? `${embeddingModelId.substring(0, 8)}-${Date.now()}`
      : embeddingModelId.substring(0, 8)
  return `${params.workspace}-${workspaceSuffix}`
}

export async function runTurboVecRag(options: RunTurboVecRagOptions) {
  const { params, content, embeddingModelId, workspace, prepareWorkspace, hasCheckpoint } = options
  let workspaceOpen = false

  try {
    await prepareWorkspace(workspace)
    const documents = params.secondDocumentContent
      ? [content, params.secondDocumentContent]
      : [content]
    workspaceOpen = true
    await ragIngest({
      modelId: embeddingModelId,
      workspace,
      documents: documents as never,
      chunk: true,
      chunkOpts: {
        chunkSize: params.chunkSize,
        chunkOverlap: params.chunkOverlap,
        ...(params.chunkStrategy
          ? { chunkStrategy: params.chunkStrategy as 'paragraph' | 'character' }
          : {})
      }
    })
    const results = await ragSearch({
      modelId: embeddingModelId,
      workspace,
      query: params.searchQuery || content,
      topK: 1
    })
    await ragCloseWorkspace({ workspace })
    workspaceOpen = false

    const checkpoint = (await hasCheckpoint(workspace)) ? 'present' : 'missing'
    return `${results[0]?.content || ''}\ncheckpoint:${checkpoint}`
  } finally {
    if (workspaceOpen) {
      try {
        await ragCloseWorkspace({ workspace })
      } catch {}
    }
    try {
      await ragDeleteWorkspace({ workspace })
    } catch {}
  }
}
