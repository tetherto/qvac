import {
  listWorkspaces as listWorkspacesFromManager,
  type RagWorkspaceInfo,
} from "@/server/bare/rag-hyperdb/rag-workspace-manager";

export function listWorkspaces(): RagWorkspaceInfo[] {
  return listWorkspacesFromManager();
}
