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

/**
 * `no-manifest` is a TurboVec workspace that never checkpointed; `no-root`
 * means it was never a TurboVec workspace, so the test proved nothing.
 */
export type TurboVecCheckpointProbe =
  { state: 'present' } | { state: 'no-manifest'; root: string } | { state: 'no-root'; root: string }

interface TurboVecPlatformOperations {
  prepareWorkspace: (workspace: string) => void | Promise<void>
  inspectCheckpoint: (
    workspace: string
  ) => TurboVecCheckpointProbe | Promise<TurboVecCheckpointProbe>
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

// QvacError carries the underlying failure as `cause`, and the lock/checkpoint
// paths report a generic message with the real errno one level down.
export function describeErrorChain(error: unknown): string {
  const parts: string[] = []
  let current: unknown = error
  for (let depth = 0; depth < 5 && current instanceof Error; depth++) {
    const code = (current as { code?: unknown }).code
    parts.push(code === undefined ? current.message : `${current.message} (code=${String(code)})`)
    current = (current as { cause?: unknown }).cause
  }
  return parts.length > 0 ? parts.join(' <- ') : String(error)
}

function describeCheckpoint(probe: TurboVecCheckpointProbe) {
  switch (probe.state) {
    case 'present':
      return 'present'
    // Path last: failure output is truncated at 200 characters.
    case 'no-manifest':
      return `missing, no checkpoint written under ${probe.root}`
    case 'no-root':
      return `missing, not a TurboVec workspace, no ${probe.root}`
  }
}

export async function runTurboVecRag(options: RunTurboVecRagOptions) {
  const { params, content, embeddingModelId, workspace, prepareWorkspace, inspectCheckpoint } =
    options
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

    const checkpoint = describeCheckpoint(await inspectCheckpoint(workspace))
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
