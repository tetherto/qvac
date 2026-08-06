import {
  listWorkspaces as listWorkspacesFromManager,
  type RagWorkspaceInfo
} from '@/rag/rag-workspace-manager'

export function listWorkspaces(): RagWorkspaceInfo[] {
  return listWorkspacesFromManager()
}
