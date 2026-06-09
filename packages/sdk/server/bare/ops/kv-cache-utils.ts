import crypto from "bare-crypto";
import { promises as fsPromises } from "bare-fs";
import path from "bare-path";
import {
  type CacheMessage,
  getAutoCacheLookupHistory,
  getKVCacheDir,
  validateAndJoinPath,
} from "@/server/utils";
import { getServerLogger } from "@/logging";
import { Buffer } from "bare-buffer";

const logger = getServerLogger();

// In-memory KV-cache state lives in `KvCacheSession` (the single
// mutation point for all three KV-cache bookkeeping layers). This
// module keeps only the pure path / hash utilities that don't touch
// in-memory state.

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
  const hash = crypto.createHash("sha-256");
  const toolNames = getToolNamesForHash(tools);
  hash.update(Buffer.from(JSON.stringify({ systemPrompt, toolNames }), "utf8"));
  return (hash.digest("hex")).substring(0, 16);
}

export function generateCacheKey(messages: CacheMessage[]): string {
  const hash = crypto.createHash("sha-256");
  const historyString = JSON.stringify(messages);
  const historyBuffer = Buffer.from(historyString, "utf8");
  hash.update(historyBuffer);
  const hashString = hash.digest("hex");
  return hashString.substring(0, 16);
}

export async function getCacheFilePath(
  modelId: string,
  configHash: string,
  cacheKey: string,
): Promise<string> {
  const cacheDir = getKVCacheDir();
  const sessionCacheDir = validateAndJoinPath(cacheDir, cacheKey);
  const modelCacheDir = validateAndJoinPath(sessionCacheDir, modelId);

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

  const previousHistory = getAutoCacheLookupHistory(currentHistory);
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
): Promise<boolean> {
  try {
    await fsPromises.rename(oldPath, newPath);
    return true;
  } catch (error) {
    logger.error(
      "Error renaming cache file:",
      error instanceof Error ? error.message : String(error),
    );
    return false;
  }
}

// Cache-existence probing (in-memory registry first, fall back to
// `fs.access`) lives in `KvCacheSession.beginTurn(...)`. Keeping the
// in-memory `initializedCaches` set private to the session module
// avoids drift between the two layers.

export async function deleteCache(
  options: { all: true } | { kvCacheKey: string; modelId?: string },
): Promise<string> {
  const cacheDir = getKVCacheDir();

  if ("all" in options) {
    await fsPromises.rm(cacheDir, { recursive: true, force: true });
    await fsPromises.mkdir(cacheDir, { recursive: true });
    return cacheDir;
  }

  const kvCacheDir = validateAndJoinPath(cacheDir, options.kvCacheKey);
  const targetDir =
    options.modelId !== undefined
      ? validateAndJoinPath(kvCacheDir, options.modelId)
      : kvCacheDir;

  await fsPromises.rm(targetDir, { recursive: true, force: true });
  return targetDir;
}
