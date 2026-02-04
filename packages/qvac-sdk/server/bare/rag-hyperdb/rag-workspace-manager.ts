import { RAG, HyperDBAdapter, type EmbeddingFunction } from "@qvac/rag";
import Corestore from "corestore";
import fs, { promises as fsPromises } from "bare-fs";
import path from "bare-path";
import { getConfiguredCacheDir } from "@/server/bare/registry/config-registry";
import {
  RAGWorkspaceModelMismatchError,
  RAGWorkspaceNotOpenError,
} from "@/utils/errors-server";
import {
  createStreamLogger,
  getServerLogger,
  ADDON_NAMESPACES,
} from "@/logging";
import { cancelAllRagOperations } from "@/server/bare/rag-hyperdb/rag-operation-manager";

const logger = getServerLogger();

// Workspace-based RAG storage
interface RagWorkspaceEntry {
  corestore: Corestore;
  dbAdapter: HyperDBAdapter;
  rag?: RAG;
  modelId?: string;
}

const ragWorkspaces = new Map<string, RagWorkspaceEntry>();

export const DEFAULT_WORKSPACE = "default";

function getWorkspaceKey(workspace?: string) {
  return workspace ?? DEFAULT_WORKSPACE;
}

function getRagBaseDir() {
  const cacheDir = getConfiguredCacheDir();
  return path.join(path.dirname(cacheDir), "rag-hyperdb");
}

function getStorePath(workspace: string) {
  return path.join(getRagBaseDir(), workspace);
}

export function hasRagWorkspaceStorage(workspace?: string) {
  const key = getWorkspaceKey(workspace);
  if (ragWorkspaces.has(key)) return true;
  return fs.existsSync(getStorePath(key));
}

async function getOrCreateWorkspaceEntry(workspace?: string) {
  const key = getWorkspaceKey(workspace);
  const existing = ragWorkspaces.get(key);
  if (existing) {
    return existing;
  }

  const storePath = getStorePath(key);
  const corestore = new Corestore(storePath);

  const dbAdapter = new HyperDBAdapter({
    store: corestore,
    dbName: key,
  });

  await dbAdapter.ready();

  const entry: RagWorkspaceEntry = {
    corestore,
    dbAdapter,
  };

  ragWorkspaces.set(key, entry);
  return entry;
}

export async function getRagDbAdapter(workspace?: string) {
  const entry = await getOrCreateWorkspaceEntry(workspace);
  return entry.dbAdapter;
}

export async function getRagInstance(
  modelId: string,
  embeddingFunction: EmbeddingFunction,
  workspace?: string,
): Promise<RAG> {
  const key = getWorkspaceKey(workspace);
  const entry = await getOrCreateWorkspaceEntry(workspace);

  if (entry.rag) {
    if (entry.modelId && entry.modelId !== modelId) {
      throw new RAGWorkspaceModelMismatchError(key, entry.modelId, modelId);
    }
    return entry.rag;
  }

  const workspaceLogger = createStreamLogger(key, ADDON_NAMESPACES.RAG_HYPERDB);

  const rag = new RAG({
    dbAdapter: entry.dbAdapter,
    embeddingFunction,
    logger: workspaceLogger,
  });

  await rag.ready();
  entry.rag = rag;
  entry.modelId = modelId;

  return rag;
}

export async function closeRagInstance(workspace?: string) {
  const key = getWorkspaceKey(workspace);
  const entry = ragWorkspaces.get(key);

  if (!entry) {
    throw new RAGWorkspaceNotOpenError(key);
  }

  if (entry.rag) {
    await entry.rag.close();
  }
  await entry.dbAdapter.close();
  await entry.corestore.close();
  ragWorkspaces.delete(key);
}

let isCleaningUp = false;

export async function closeAllRagInstances() {
  if (isCleaningUp) return;
  isCleaningUp = true;

  try {
    cancelAllRagOperations();

    const closures = Array.from(ragWorkspaces.entries()).map(
      async ([key, entry]) => {
        if (entry.rag) {
          await entry.rag.close();
        }
        await entry.dbAdapter.close();
        await entry.corestore.close();
        ragWorkspaces.delete(key);
      },
    );

    await Promise.all(closures);
  } catch (error) {
    logger.error("❌ Error during RAG cleanup:", error);
  } finally {
    isCleaningUp = false;
  }
}

// ============== Workspace Management ==============

export interface RagWorkspaceInfo {
  name: string;
  open: boolean;
}

export function listWorkspaces(): RagWorkspaceInfo[] {
  const baseDir = getRagBaseDir();

  if (!fs.existsSync(baseDir)) {
    return [];
  }

  const entries = fs.readdirSync(baseDir, {
    withFileTypes: true,
  }) as unknown as Array<{
    name: string;
    isDirectory: () => boolean;
  }>;

  const directories = entries.filter(
    (entry) => entry.isDirectory() && !entry.name.startsWith("."),
  );

  return directories.map((entry) => ({
    name: entry.name,
    open: ragWorkspaces.has(entry.name),
  }));
}

export function isWorkspaceLoaded(workspace: string) {
  const key = getWorkspaceKey(workspace);
  return ragWorkspaces.has(key);
}

export async function deleteWorkspace(workspace: string) {
  const key = getWorkspaceKey(workspace);
  const storePath = getStorePath(key);

  if (!fs.existsSync(storePath)) {
    return false;
  }

  await fsPromises.rm(storePath, { recursive: true, force: true });

  return true;
}
