import { RAG, HyperDBAdapter, type EmbeddingFunction } from "@qvac/rag";
import Corestore from "corestore";
import path from "bare-path";
import { getEnv } from "@/server/worker";
import { RAGWorkspaceModelMismatchError } from "@/utils/errors-server";
import { getServerLogger } from "@/logging";

const logger = getServerLogger();

// Workspace-based RAG instance management
interface RagInstanceEntry {
  rag: RAG;
  corestore: Corestore;
  modelId: string;
}

const ragInstances = new Map<string, RagInstanceEntry>();

const defaultWorkspace = "default";

const getStorePath = (workspace: string) => {
  const homeDir = getEnv().HOME_DIR;
  return path.join(homeDir, ".qvac", "rag-hyperdb", workspace);
};

export const getRagInstance = async (
  modelId: string,
  embeddingFunction: EmbeddingFunction,
  workspace?: string,
): Promise<RAG> => {
  const key = workspace ?? defaultWorkspace;
  const existingEntry = ragInstances.get(key);

  if (existingEntry) {
    // Validate model consistency
    if (existingEntry.modelId !== modelId) {
      throw new RAGWorkspaceModelMismatchError(
        key,
        existingEntry.modelId,
        modelId,
      );
    }
    return existingEntry.rag;
  }

  // Create new instance for this workspace
  const storePath = getStorePath(key);
  const corestore = new Corestore(storePath);

  // Create HyperDB adapter
  const hyperdbAdapter = new HyperDBAdapter({
    store: corestore,
  });

  const rag = new RAG({
    dbAdapter: hyperdbAdapter,
    embeddingFunction,
  });

  await rag.ready();
  ragInstances.set(key, {
    rag,
    corestore,
    modelId,
  });

  return rag;
};

export const closeRagInstance = async (workspace?: string): Promise<void> => {
  const key = workspace ?? defaultWorkspace;
  const entry = ragInstances.get(key);

  if (entry) {
    await entry.rag.close();
    ragInstances.delete(key);
  }
};

let isCleaningUp = false;

export const closeAllRagInstances = async (): Promise<void> => {
  if (isCleaningUp) return;
  isCleaningUp = true;

  try {
    const closures = Array.from(ragInstances.entries()).map(
      async ([key, entry]) => {
        await entry.rag.close();
        ragInstances.delete(key);
      },
    );

    await Promise.all(closures);
  } catch (error) {
    logger.error("❌ Error during RAG cleanup:", error);
  }
};
