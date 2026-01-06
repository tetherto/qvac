import { type DownloadEntry } from "@/schemas";
import { getServerLogger } from "@/logging";

const logger = getServerLogger();

const activeDownloads = new Map<string, DownloadEntry>();
const clearCacheFlags = new Map<string, boolean>();

export const getActiveDownload = (key: string): DownloadEntry | undefined =>
  activeDownloads.get(key);

export const registerDownload = (key: string, entry: DownloadEntry): void => {
  activeDownloads.set(key, entry);
};

export const unregisterDownload = (key: string): void => {
  activeDownloads.delete(key);
};

export const createHyperdriveDownloadKey = (
  hyperdriveKey: string,
  modelFileName: string,
): string => `${hyperdriveKey}:${modelFileName}`;

export const createHttpDownloadKey = (url: string): string => `http:${url}`;

export const setClearCacheFlag = (downloadKey: string, clearCache: boolean) => {
  if (clearCache) {
    clearCacheFlags.set(downloadKey, true);
  } else {
    clearCacheFlags.delete(downloadKey);
  }
};

export const shouldClearCache = (downloadKey: string): boolean =>
  clearCacheFlags.get(downloadKey) ?? false;

export const clearClearCacheFlag = (downloadKey: string) => {
  clearCacheFlags.delete(downloadKey);
};

export const createCancelFunction =
  (downloadKey: string, clearCache = false) =>
  () => {
    const entry = getActiveDownload(downloadKey);
    if (!entry) {
      return;
    }

    // Set flag for the download handlers to check
    setClearCacheFlag(downloadKey, clearCache);

    entry.abortController.abort();
    unregisterDownload(downloadKey);
  };

export const cancelAllDownloads = (): void => {
  logger.info(`🧹 Cancelling ${activeDownloads.size} active downloads`);

  Array.from(activeDownloads.keys()).forEach((key) =>
    createCancelFunction(key)(),
  );
};

let isCleaningUp = false;

export const cleanupDownloads = async (): Promise<void> => {
  if (isCleaningUp) return;
  isCleaningUp = true;

  try {
    const downloadPromises = Array.from(activeDownloads.values()).map(
      (entry) => entry.promise.catch(() => {}), // Ignore errors, we're shutting down
    );

    cancelAllDownloads();

    if (downloadPromises.length > 0) {
      await Promise.allSettled(downloadPromises);
    }
  } catch (error) {
    logger.error("❌ Error during download cleanup:", error);
  }
};
