import {
  listWorkspaces as listWorkspacesFromManager,
  type RagWorkspaceInfo
} from '../rag-workspace-manager.ts'

export function listWorkspaces(): RagWorkspaceInfo[] {
  return listWorkspacesFromManager()
}
