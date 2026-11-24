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

type IndicTransDirection = "en-indic" | "indic-en" | "indic-indic";
type IndicTransQuantization = "q4_0" | "f16";

function registryModel(
  direction: IndicTransDirection,
  size: string,
  quantization: IndicTransQuantization,
  expectedMinSizeMB: number,
): IndicTransModelInfo {
  const variant = size === "1B" ? size : `dist-${size}`;
  const modelName = `ggml-indictrans2-${direction}-${variant}`;
  const filename = `${modelName}-${quantization}.bin`;
  return {
    registryPath: `qvac_models_compiled/ggml/indictrans2/${quantization}/${modelName}/2026-01-01/${filename}`,
    registrySource: "s3",
    filename,
    expectedMinSizeMB,
  };
}

export const INDICTRANS_MODELS: Record<string, IndicTransModelInfo> = {
  "en-indic-200M-q4_0": registryModel("en-indic", "200M", "q4_0", 100),
  "en-indic-200M-f16": registryModel("en-indic", "200M", "f16", 330),
  "en-indic-1B-q4_0": registryModel("en-indic", "1B", "q4_0", 480),
  "en-indic-1B-f16": registryModel("en-indic", "1B", "f16", 1700),
  "indic-en-200M-q4_0": registryModel("indic-en", "200M", "q4_0", 100),
  "indic-en-200M-f16": registryModel("indic-en", "200M", "f16", 330),
  "indic-en-1B-q4_0": registryModel("indic-en", "1B", "q4_0", 440),
  "indic-en-1B-f16": registryModel("indic-en", "1B", "f16", 1560),
  "indic-indic-320M-q4_0": registryModel("indic-indic", "320M", "q4_0", 150),
  "indic-indic-320M-f16": registryModel("indic-indic", "320M", "f16", 500),
  "indic-indic-1B-q4_0": registryModel("indic-indic", "1B", "q4_0", 530),
  "indic-indic-1B-f16": registryModel("indic-indic", "1B", "f16", 1850),
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

type RegistryClientConstructor = new () => RegistryClient;
const MODULE_NOT_FOUND_CODE = "MODULE_NOT_FOUND";
const MISSING_MODULE_PATTERN =
  /^(?:MODULE_NOT_FOUND:\s*)?Cannot find (?:module|package) ['"]([^'"]+)['"]/;

function missingModuleSpecifier(error: Error): string | undefined {
  return MISSING_MODULE_PATTERN.exec(error.message)?.[1];
}

function isMissingModuleError(error: unknown, moduleName: string): boolean {
  return (
    error instanceof Error &&
    "code" in error &&
    error.code === MODULE_NOT_FOUND_CODE &&
    missingModuleSpecifier(error) === moduleName
  );
}

function loadRegistryClient(): RegistryClientConstructor {
  try {
    const loadModule: (id: string) => unknown = require;
    const { QVACRegistryClient } = loadModule("@qvac/registry-client") as {
      QVACRegistryClient: RegistryClientConstructor;
    };
    return QVACRegistryClient;
  } catch (error) {
    if (!isMissingModuleError(error, "@qvac/registry-client")) throw error;
    throw new Error(
      "Install @qvac/registry-client to download IndicTrans translation models",
      { cause: error },
    );
  }
}

/**
 * Downloads an IndicTrans model file from the QVAC model registry.
 */
export async function downloadIndicTransFromRegistry(
  modelKey: string,
  destPath: string,
): Promise<string> {
  const modelInfo = INDICTRANS_MODELS[modelKey];
  if (!modelInfo) {
    throw new Error(
      `Unknown IndicTrans model key: ${modelKey}. Available: ${Object.keys(INDICTRANS_MODELS).join(", ")}`,
    );
  }

  const QVACRegistryClient = loadRegistryClient();
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
