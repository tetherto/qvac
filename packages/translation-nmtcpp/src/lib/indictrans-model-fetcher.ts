/**
 * IndicTrans Model Fetcher
 *
 * Downloads IndicTrans2 GGML model files from the QVAC model registry.
 *
 * This module does NOT touch Bergamot or OPUS models.
 */

/* eslint-disable @typescript-eslint/no-require-imports -- Bare modules expose CommonJS export shapes. */
import fs = require("bare-fs");
import path = require("bare-path");
/* eslint-enable @typescript-eslint/no-require-imports */

// ============================================================================
// Model registry paths (from SDK models.ts)
// ============================================================================

interface IndicTransModelInfo {
  registryPath: string;
  registrySource: string;
  filename: string;
  expectedMinSizeMB: number;
}

export const INDICTRANS_MODELS: Record<string, IndicTransModelInfo> = {
  "en-indic-200M-q4_0": {
    registryPath:
      "qvac_models_compiled/ggml/indictrans2/q4_0/ggml-indictrans2-en-indic-dist-200M/2026-01-01/ggml-indictrans2-en-indic-dist-200M-q4_0.bin",
    registrySource: "s3",
    filename: "ggml-indictrans2-en-indic-dist-200M-q4_0.bin",
    expectedMinSizeMB: 100,
  },
};

// ============================================================================
// Helpers
// ============================================================================

/**
 * Checks whether a file exists and meets minimum size requirements.
 */
function hasValidModelFile(filePath: string, minSizeMB: number): boolean {
  try {
    const stats = fs.statSync(filePath);
    return stats.size >= minSizeMB * 1024 * 1024;
  } catch {
    return false;
  }
}

// ============================================================================
// Download via QVAC Registry
// ============================================================================

interface RegistryClient {
  ready(): Promise<void>;
  close(): Promise<void>;
  downloadModel(
    registryPath: string,
    registrySource: string,
    options: { outputFile: string },
  ): Promise<{ artifact: { path: string } }>;
}

/**
 * Downloads an IndicTrans model file from the QVAC model registry.
 */
export async function downloadIndicTransFromRegistry(
  modelKey: string,
  destPath: string,
): Promise<string> {
  // eslint-disable-next-line @typescript-eslint/no-require-imports -- registry client is loaded lazily so production installs without it stay usable.
  const { QVACRegistryClient } = require("@qvac/registry-client") as {
    QVACRegistryClient: new () => RegistryClient;
  };

  const modelInfo = INDICTRANS_MODELS[modelKey];
  if (!modelInfo) {
    throw new Error(
      `Unknown IndicTrans model key: ${modelKey}. Available: ${Object.keys(INDICTRANS_MODELS).join(", ")}`,
    );
  }

  console.log(
    `[indictrans-fetcher] Downloading ${modelInfo.filename} from QVAC registry...`,
  );

  const client = new QVACRegistryClient();
  await client.ready();

  try {
    const destDir = path.dirname(destPath);
    fs.mkdirSync(destDir, { recursive: true });

    const result = await client.downloadModel(
      modelInfo.registryPath,
      modelInfo.registrySource,
      {
        outputFile: destPath,
      },
    );

    console.log(
      `[indictrans-fetcher] Download complete → ${result.artifact.path}`,
    );

    if (!hasValidModelFile(destPath, modelInfo.expectedMinSizeMB)) {
      throw new Error(
        `Downloaded file seems corrupted (expected >${modelInfo.expectedMinSizeMB}MB)`,
      );
    }

    return destPath;
  } finally {
    await client.close();
  }
}

// ============================================================================
// Public API
// ============================================================================

/**
 * Ensures an IndicTrans model file is present at destPath.
 *
 *   1. If a valid model file already exists → returns immediately
 *   2. Downloads from QVAC model registry
 *
 * @param destPath  Full path where the model file should be stored
 * @param modelKey  Model variant key
 * @returns Resolved path to the model file
 */
export async function ensureIndicTransModelFile(
  destPath: string,
  modelKey = "en-indic-200M-q4_0",
): Promise<string> {
  const modelInfo = INDICTRANS_MODELS[modelKey];
  if (!modelInfo) {
    throw new Error(
      `Unknown IndicTrans model key: ${modelKey}. Available: ${Object.keys(INDICTRANS_MODELS).join(", ")}`,
    );
  }

  if (hasValidModelFile(destPath, modelInfo.expectedMinSizeMB)) {
    console.log(`[indictrans-fetcher] Model already available at ${destPath}`);
    return destPath;
  }

  return downloadIndicTransFromRegistry(modelKey, destPath);
}

/**
 * Returns the default filename for an IndicTrans model variant.
 *
 * @param modelKey  Model variant key
 * @returns Filename
 */
export function getIndicTransFileName(modelKey = "en-indic-200M-q4_0"): string {
  const modelInfo = INDICTRANS_MODELS[modelKey];
  if (!modelInfo) {
    throw new Error(
      `Unknown IndicTrans model key: ${modelKey}. Available: ${Object.keys(INDICTRANS_MODELS).join(", ")}`,
    );
  }
  return modelInfo.filename;
}
