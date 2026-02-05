import crypto from "bare-crypto";
import { promises as fsPromises } from "bare-fs";
import path from "bare-path";
import { getKVCacheDir } from "@/server/utils";
import { getServerLogger } from "@/logging";

const logger = getServerLogger();

// In-memory registry tracks caches initialized this session (addon defers disk writes)
const initializedCaches = new Set<string>();

function getCacheRegistryKey(
  modelId: string,
  configHash: string,
  cacheKey: string,
): string {
  return `${modelId}:${configHash}:${cacheKey}`;
}

export function markCacheInitialized(
  modelId: string,
  configHash: string,
  cacheKey: string,
): void {
  initializedCaches.add(getCacheRegistryKey(modelId, configHash, cacheKey));
}

export function isCacheInitialized(
  modelId: string,
  configHash: string,
  cacheKey: string,
): boolean {
  return initializedCaches.has(
    getCacheRegistryKey(modelId, configHash, cacheKey),
  );
}

export function clearCacheRegistry(cacheKey?: string): void {
  if (cacheKey) {
    for (const key of initializedCaches) {
      if (key.includes(`:${cacheKey}`)) {
        initializedCaches.delete(key);
      }
    }
  } else {
    initializedCaches.clear();
  }
}

export interface CacheMessage {
  role: string;
  content: string;
  attachments?: { path: string }[] | undefined;
}

export function extractSystemPrompt(messages: CacheMessage[]): string | null {
  const systemMessage = messages.find((msg) => msg.role === "system");
  return systemMessage ? systemMessage.content : null;
}

interface ToolLike {
  name: string;
}

function getToolNamesForHash(tools: unknown): string[] {
  if (!Array.isArray(tools)) return [];
  return (tools as ToolLike[])
    .map((t) => t.name)
    .filter((n) => typeof n === "string")
    .sort();
}

// Cache hash based on system prompt + tool names
// Different tools = different cache (tools anchored in first message, protected from n_discarded)
export function generateConfigHash(
  systemPrompt: string | null,
  tools?: unknown,
): string {
  const hash = crypto.createHash("sha256");
  const toolNames = getToolNamesForHash(tools);
  hash.update(Buffer.from(JSON.stringify({ systemPrompt, toolNames }), "utf8"));
  return (hash.digest("hex") as string).substring(0, 16);
}

export function generateCacheKey(messages: CacheMessage[]): string {
  const hash = crypto.createHash("sha256");
  const historyString = JSON.stringify(messages);
  const historyBuffer = Buffer.from(historyString, "utf8");
  hash.update(historyBuffer);
  const hashString = hash.digest("hex") as string;
  return hashString.substring(0, 16);
}

export async function getCacheFilePath(
  modelId: string,
  configHash: string,
  cacheKey: string,
): Promise<string> {
  const cacheDir = getKVCacheDir();
  const sessionCacheDir = path.join(cacheDir, cacheKey);
  const modelCacheDir = path.join(sessionCacheDir, modelId);

  try {
    await fsPromises.mkdir(sessionCacheDir, { recursive: true });
    await fsPromises.mkdir(modelCacheDir, { recursive: true });
  } catch {
    // Ignore if directories already exist
  }

  return path.join(modelCacheDir, `${configHash}.bin`);
}

// Used for auto-generated cache key
export async function findMatchingCache(
  modelId: string,
  configHash: string,
  currentHistory: CacheMessage[],
): Promise<{ cacheKey: string; cachePath: string } | null> {
  if (currentHistory.length <= 1) {
    return null;
  }

  // Generate cache key for history minus the last message
  const previousHistory = currentHistory.slice(0, -1);
  const cacheKey = generateCacheKey(previousHistory);
  const cachePath = await getCacheFilePath(modelId, configHash, cacheKey);

  try {
    await fsPromises.access(cachePath);
    return { cacheKey, cachePath };
  } catch {
    return null;
  }
}

export async function getCurrentCacheInfo(
  modelId: string,
  configHash: string,
  currentHistory: CacheMessage[],
): Promise<{
  cacheKey: string;
  cachePath: string;
}> {
  const cacheKey = generateCacheKey(currentHistory);
  const cachePath = await getCacheFilePath(modelId, configHash, cacheKey);
  return { cacheKey, cachePath };
}

export async function renameCacheFile(
  oldPath: string,
  newPath: string,
): Promise<void> {
  try {
    await fsPromises.rename(oldPath, newPath);
  } catch (error) {
    logger.error(
      "Error renaming cache file:",
      error instanceof Error ? error.message : String(error),
    );
  }
}

export async function customCacheExists(
  modelId: string,
  configHash: string,
  cacheKey: string,
): Promise<boolean> {
  // Check in-memory registry first (addon defers disk writes)
  if (isCacheInitialized(modelId, configHash, cacheKey)) {
    return true;
  }

  // Then check file system (for caches from previous runs)
  const cachePath = await getCacheFilePath(modelId, configHash, cacheKey);
  try {
    await fsPromises.access(cachePath);
    markCacheInitialized(modelId, configHash, cacheKey);
    return true;
  } catch {
    return false;
  }
}

export async function deleteCache(
  options: { all: true } | { kvCacheKey: string; modelId?: string },
): Promise<void> {
  const cacheDir = getKVCacheDir();

  if ("all" in options && options.all) {
    try {
      await fsPromises.rm(cacheDir, { recursive: true });
      await fsPromises.mkdir(cacheDir, { recursive: true });
    } catch (error) {
      logger.error(
        "Error deleting all caches:",
        error instanceof Error ? error.message : String(error),
      );
    }
  } else if ("kvCacheKey" in options) {
    const kvCacheDir = path.join(cacheDir, options.kvCacheKey);

    if (options.modelId) {
      const modelCacheDir = path.join(kvCacheDir, options.modelId);
      try {
        await fsPromises.rm(modelCacheDir, { recursive: true });
      } catch (error) {
        logger.error(
          `Error deleting model cache ${options.kvCacheKey}/${options.modelId}:`,
          error instanceof Error ? error.message : String(error),
        );
      }
    } else {
      try {
        await fsPromises.rm(kvCacheDir, { recursive: true });
      } catch (error) {
        logger.error(
          `Error deleting cache ${options.kvCacheKey}:`,
          error instanceof Error ? error.message : String(error),
        );
      }
    }
  }
}
