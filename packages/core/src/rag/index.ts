export { chunk } from './handlers/chunk'
export { ingest } from './handlers/ingest'
export { saveEmbeddings } from './handlers/save-embeddings'
export { search } from './handlers/search'
export { deleteEmbeddings } from './handlers/delete-embeddings'
export { reindex } from './handlers/reindex'
export { listWorkspaces } from './handlers/list-workspaces'
export { closeWorkspace } from './handlers/close-workspace'
export { deleteWorkspace } from './handlers/delete-workspace'
export {
  closeAllRagInstances,
  DEFAULT_WORKSPACE,
  type RagWorkspaceInfo
} from './rag-workspace-manager'
export {
  getActiveRagRequest,
  setActiveRagRequest,
  clearActiveRagRequest,
  getWorkspaceKey
} from './rag-operation-manager'
