import { AbortController, type AbortSignal } from "bare-abort-controller";
import { DEFAULT_WORKSPACE } from "@/server/bare/rag-hyperdb/rag-workspace-manager";

interface RagOperationEntry {
  abortController: AbortController;
  operation: string;
  startTime: number;
}

// Map of workspace -> active operation
const activeOperations = new Map<string, RagOperationEntry>();

export function getWorkspaceKey(workspace?: string) {
  return workspace ?? DEFAULT_WORKSPACE;
}

export function registerRagOperation(
  workspace: string | undefined,
  operation: string,
): AbortSignal {
  const key = getWorkspaceKey(workspace);

  // Cancel any existing operation on this workspace
  cancelRagOperation(workspace);

  const abortController = new AbortController();
  activeOperations.set(key, {
    abortController,
    operation,
    startTime: Date.now(),
  });

  return abortController.signal;
}

export function unregisterRagOperation(workspace?: string): void {
  const key = getWorkspaceKey(workspace);
  activeOperations.delete(key);
}

export function cancelRagOperation(workspace?: string): boolean {
  const key = getWorkspaceKey(workspace);
  const entry = activeOperations.get(key);

  if (!entry) {
    return false;
  }

  entry.abortController.abort();
  activeOperations.delete(key);
  return true;
}

export function cancelAllRagOperations(): void {
  for (const [key, entry] of activeOperations.entries()) {
    entry.abortController.abort();
    activeOperations.delete(key);
  }
}
