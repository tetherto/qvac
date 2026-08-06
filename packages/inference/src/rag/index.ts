export { chunk } from '@/rag/handlers/chunk'
export { ingest } from '@/rag/handlers/ingest'
export { saveEmbeddings } from '@/rag/handlers/save-embeddings'
export { search } from '@/rag/handlers/search'
export { deleteEmbeddings } from '@/rag/handlers/delete-embeddings'
export { reindex } from '@/rag/handlers/reindex'
export { listWorkspaces } from '@/rag/handlers/list-workspaces'
export { closeWorkspace } from '@/rag/handlers/close-workspace'
export { deleteWorkspace } from '@/rag/handlers/delete-workspace'
export {
  closeAllRagInstances,
  DEFAULT_WORKSPACE,
  type RagWorkspaceInfo
} from '@/rag/rag-workspace-manager'
export {
  getActiveRagRequest,
  setActiveRagRequest,
  clearActiveRagRequest,
  getWorkspaceKey
} from '@/rag/rag-operation-manager'
