export { chunk } from './handlers/chunk.ts'
export { ingest } from './handlers/ingest.ts'
export { saveEmbeddings } from './handlers/save-embeddings.ts'
export { search } from './handlers/search.ts'
export { deleteEmbeddings } from './handlers/delete-embeddings.ts'
export { reindex } from './handlers/reindex.ts'
export { listWorkspaces } from './handlers/list-workspaces.ts'
export { closeWorkspace } from './handlers/close-workspace.ts'
export { deleteWorkspace } from './handlers/delete-workspace.ts'
export {
  closeAllRagInstances,
  DEFAULT_WORKSPACE,
  type RagWorkspaceInfo
} from './rag-workspace-manager.ts'
export {
  getActiveRagRequest,
  setActiveRagRequest,
  clearActiveRagRequest,
  getWorkspaceKey
} from './rag-operation-manager.ts'
