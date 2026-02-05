import fs from "fs";
import { fileURLToPath } from "url";
import { execSync } from "child_process";
import { QVACRegistryClient } from "@tetherto/qvac-lib-registry-client";

// Default QVAC Registry core key - this is the public registry that contains all QVAC models
const DEFAULT_REGISTRY_CORE_KEY =
  "87artu7udixab7hy4wf9m6gjdkfihjw34da8orib8phd986amseo";

const OUTPUT_FILE = fileURLToPath(
  new URL("../models/hyperdrive/models.ts", import.meta.url),
);
const HISTORY_DIR = fileURLToPath(
  new URL("../models/history", import.meta.url),
);

// Map registry engine names to addon types
const ENGINE_TO_ADDON = {
  "@qvac/llm-llamacpp": "llm",
  "@qvac/transcription-whispercpp": "whisper",
  "@qvac/embed-llamacpp": "embeddings",
  "@qvac/translation-nmtcpp": "nmt",
  "@qvac/translation-llamacpp": "nmt", // LLM-based translation
  "@qvac/vad-silero": "vad",
  "@qvac/tts-onnx": "tts",
  "@qvac/ocr-onnx": "ocr",
  // Alternative engine names
  generation: "llm",
  transcription: "whisper",
  embedding: "embeddings",
  translation: "nmt",
  vad: "vad",
  tts: "tts",
  ocr: "ocr",
};

const detectShardedModel = (filename) => {
  const shardPattern = /^(.+)-(\d{5})-of-(\d{5})(\.\w+)$/;
  const match = filename.match(shardPattern);

  if (match) {
    return {
      isSharded: true,
      baseFilename: match[1],
      currentShard: parseInt(match[2], 10),
      totalShards: parseInt(match[3], 10),
      extension: match[4],
    };
  }

  return { isSharded: false };
};

const getAddonFromEngine = (engine) => {
  if (!engine) return null;

  // Try direct match first
  if (ENGINE_TO_ADDON[engine]) {
    return ENGINE_TO_ADDON[engine];
  }

  // Try lowercase
  const engineLower = engine.toLowerCase();
  if (ENGINE_TO_ADDON[engineLower]) {
    return ENGINE_TO_ADDON[engineLower];
  }

  // Try extracting from engine name (e.g., "@qvac/llm-llamacpp" -> "llm")
  for (const [key, value] of Object.entries(ENGINE_TO_ADDON)) {
    if (engine.includes(key) || key.includes(engine)) {
      return value;
    }
  }

  return null;
};

const generateExportName = ({
  path,
  engine,
  name,
  quantization,
  usedNames,
}) => {
  const cleanPart = (p) => {
    if (!p) return "";
    return p
      .replace(/ggml-?/gi, "")
      .replace(/gguf-?/gi, "")
      .replace(/instruct/gi, "inst")
      .replace(/^-+|-+$/g, "")
      .toUpperCase()
      .replace(/[^A-Z0-9]+/g, "_");
  };

  const addon = getAddonFromEngine(engine);
  let exportName = "";

  // Extract filename from path for additional context
  const filename = path.split("/").pop() || path;

  if (addon === "whisper") {
    // WHISPER models: WHISPER_<size>_<quantization> or WHISPER_<size>_<lang>_<quantization>
    // Extract size (tiny, base, small, medium, large) from filename
    const sizeMatch = filename.match(
      /\b(tiny|base|small|medium|large(?:-v[0-9]+)?(?:-turbo)?)\b/i,
    );
    const modelSize = sizeMatch ? sizeMatch[1] : "";

    // Check for language variant (e.g., "base.en" -> "en")
    const langMatch = filename.match(/\.(en)\b/i);
    const lang = langMatch ? langMatch[1] : "";

    const nameParts = [modelSize, lang, quantization].filter(
      (p) => p && p !== "",
    );
    exportName = `WHISPER_${nameParts.map(cleanPart).join("_")}`;
  } else if (addon === "vad") {
    // VAD models: VAD_<name>
    const nameParts = [name].filter((p) => p && p !== "");
    exportName = `VAD_${nameParts.map(cleanPart).join("_")}`;
  } else if (addon === "nmt") {
    // Translation models - distinguish between different types
    const lowerFilename = filename.toLowerCase();
    const lowerPath = path.toLowerCase();

    // Check for Salamandra (LLM-based Spanish translation)
    if (
      lowerPath.includes("salamandra") ||
      lowerFilename.includes("salamandra")
    ) {
      const nameParts = [name, quantization].filter((p) => p && p !== "");
      exportName = `SALAMANDRA_${nameParts.map(cleanPart).join("_")}`;
    }
    // Check for IndicTrans2
    else if (
      lowerPath.includes("indictrans") ||
      lowerFilename.includes("indictrans")
    ) {
      // Extract language direction from filename (e.g., "en-indic" or "indic-en")
      const langMatch = filename.match(/(en-indic|indic-en)/i);
      const langDir = langMatch
        ? langMatch[1].toUpperCase().replace("-", "_")
        : "";
      const sizeMatch = filename.match(/(\d+[MB])/i);
      const size = sizeMatch ? sizeMatch[1] : "";
      const nameParts = [langDir, size, quantization].filter(
        (p) => p && p !== "",
      );
      exportName = `INDICTRANS_${nameParts.map(cleanPart).join("_")}`;
    }
    // Check for OPUS models
    else if (lowerPath.includes("opus") || lowerFilename.includes("opus")) {
      // Extract language pair from filename (e.g., "en-de", "en-it")
      const langMatch = filename.match(/-([a-z]{2})-([a-z]{2})\./i);
      const langPair = langMatch
        ? `${langMatch[1].toUpperCase()}_${langMatch[2].toUpperCase()}`
        : "";
      const nameParts = [langPair, quantization].filter((p) => p && p !== "");
      exportName = `OPUS_${nameParts.map(cleanPart).join("_")}`;
    }
    // Check for Bergamot models
    else if (
      lowerPath.includes("bergamot") ||
      lowerFilename.includes("bergamot")
    ) {
      const langMatch = filename.match(/\.([a-z]{2})-([a-z]{2})\./i);
      const langPair = langMatch
        ? `${langMatch[1].toUpperCase()}_${langMatch[2].toUpperCase()}`
        : "";
      const nameParts = [langPair].filter((p) => p && p !== "");
      exportName = `BERGAMOT_${nameParts.map(cleanPart).join("_")}`;
    }
    // Generic NMT fallback
    else {
      const nameParts = [name, quantization].filter((p) => p && p !== "");
      exportName = `NMT_${nameParts.map(cleanPart).join("_")}`;
    }
  } else if (addon === "llm") {
    // LLM models: <name>_<quantization>
    const nameParts = [name, quantization].filter((p) => p && p !== "");
    exportName = nameParts.map(cleanPart).join("_");
    if (filename.includes("mmproj")) {
      exportName = "MMPROJ_" + exportName;
    }
  } else if (addon === "embeddings") {
    // Embeddings: <name>_<quantization>
    const nameParts = [name, quantization].filter((p) => p && p !== "");
    exportName = nameParts.map(cleanPart).join("_");
  } else if (addon === "tts") {
    // TTS models: TTS_<name>
    const nameParts = [name].filter((p) => p && p !== "");
    exportName = `TTS_${nameParts.map(cleanPart).join("_")}`;
    if (filename.includes("config.json")) {
      exportName = exportName + "_CONFIG";
    }
  } else if (addon === "ocr") {
    // OCR models: OCR_<name>_<DETECTOR|RECOGNIZER>
    let fileType = "";
    if (filename.includes("detector")) {
      fileType = "DETECTOR";
    } else if (filename.includes("recognizer")) {
      fileType = "RECOGNIZER";
    }
    const nameParts = [name, fileType].filter((p) => p && p !== "");
    exportName = `OCR_${nameParts.map(cleanPart).join("_")}`;
  } else {
    // Generic fallback using path
    exportName = cleanPart(filename.replace(/\.\w+$/, ""));
  }

  // Clean up the name
  exportName = exportName.replace(/^_+|_+$/g, "").replace(/_+/g, "_");

  // Add SHARD suffix for sharded models
  if (detectShardedModel(filename).isSharded) {
    exportName = `${exportName}_SHARD`;
  }

  // Ensure uniqueness
  let finalName = exportName || "UNKNOWN_MODEL";
  let counter = 1;
  while (usedNames.has(finalName)) {
    finalName = `${exportName}_${counter++}`;
  }
  usedNames.add(finalName);

  return finalName;
};

const generateModelsFileContent = (models) => {
  const usedNames = new Set();

  // Generate names first pass to add to model objects
  const modelsWithNames = models.map((m) => ({
    ...m,
    name: generateExportName({
      path: m.registryPath,
      engine: m.engine,
      name: m.modelName,
      quantization: m.quantization,
      usedNames,
    }),
  }));

  return generateFileContentWithNames(modelsWithNames);
};

const generateFileContentWithNames = (modelsWithNames) => {
  const entries = modelsWithNames
    .map((m) => {
      // addon is already in short form (llm, whisper, etc.) from ENGINE_TO_ADDON
      const addonAlias = m.addon;
      let entry = `  {
    name: "${m.name}",
    registryPath: "${m.registryPath}",
    registrySource: "${m.registrySource}",
    blobCoreKey: "${m.blobCoreKey}",
    blobBlockOffset: ${m.blobBlockOffset},
    blobBlockLength: ${m.blobBlockLength},
    blobByteOffset: ${m.blobByteOffset},
    modelId: "${m.modelId}",
    addon: "${addonAlias}",
    expectedSize: ${m.expectedSize},
    sha256Checksum: "${m.sha256Checksum}",
    engine: "${m.engine || ""}",
    quantization: "${m.quantization || ""}",
    params: "${m.params || ""}"`;

      if (m.shardMetadata) {
        entry += `,\n    shardMetadata: ${JSON.stringify(m.shardMetadata)}`;
      }

      entry += "\n  }";
      return entry;
    })
    .join(",\n");

  const exports = modelsWithNames
    .map((m, i) => {
      return `export const ${m.name} = {
  name: "${m.name}",
  src: \`registry://\${models[${i}].registrySource}/\${models[${i}].registryPath}\`,
  registryPath: models[${i}].registryPath,
  registrySource: models[${i}].registrySource,
  blobCoreKey: models[${i}].blobCoreKey,
  blobBlockOffset: models[${i}].blobBlockOffset,
  blobBlockLength: models[${i}].blobBlockLength,
  blobByteOffset: models[${i}].blobByteOffset,
  modelId: models[${i}].modelId,
  expectedSize: models[${i}].expectedSize,
  sha256Checksum: models[${i}].sha256Checksum,
  addon: models[${i}].addon,
  engine: models[${i}].engine,
  quantization: models[${i}].quantization,
  params: models[${i}].params,
} as const;`;
    })
    .join("\n\n");

  return `// THIS FILE IS AUTO-GENERATED BY scripts/update-models.js
// DO NOT MODIFY MANUALLY

export type RegistryItem = {
  name: string;
  registryPath: string;
  registrySource: string;
  blobCoreKey: string;
  blobBlockOffset: number;
  blobBlockLength: number;
  blobByteOffset: number;
  modelId: string;
  addon: "llm" | "whisper" | "embeddings" | "nmt" | "vad" | "tts" | "ocr" | "other";
  expectedSize: number;
  sha256Checksum: string;
  engine: string;
  quantization: string;
  params: string;
  shardMetadata?: readonly { 
    filename: string; 
    expectedSize: number; 
    sha256Checksum: string; 
    blobCoreKey: string; 
    blobBlockOffset: number;
    blobBlockLength: number;
    blobByteOffset: number;
  }[];
};

export type ModelConstant = {
  name: string;
  src: string;
  registryPath: string;
  registrySource: string;
  blobCoreKey: string;
  blobBlockOffset: number;
  blobBlockLength: number;
  blobByteOffset: number;
  modelId: string;
  expectedSize: number;
  sha256Checksum: string;
  addon: "llm" | "whisper" | "embeddings" | "nmt" | "vad" | "tts" | "ocr" | "other";
  engine: string;
  quantization: string;
  params: string;
};

export const models = [
${entries}
] as const satisfies readonly RegistryItem[];

// Individual model constants for direct import/use with loadModel
// These contain all metadata and can be used directly: loadModel({ modelSrc: WHISPER_TINY, ... })
${exports}

// Helper function to get model by name
export function getModelByName(name: string): RegistryItem | undefined {
  return models.find((model) => model.name === name);
}

// Helper function to get model by registry path
export function getModelByPath(registryPath: string): RegistryItem | undefined {
  return models.find((model) => model.registryPath === registryPath);
}

// Helper function for blob-based lookups
export function getModelBySrc(modelId: string, blobCoreKey: string): RegistryItem | undefined {
  return models.find((model) => model.modelId === modelId && model.blobCoreKey === blobCoreKey);
}
`;
};

// Helper to convert Buffer or hex string to hex string
const toHexString = (value) => {
  if (!value) return "";
  if (Buffer.isBuffer(value)) return value.toString("hex");
  if (typeof value === "string") return value;
  if (value.data) return Buffer.from(value.data).toString("hex");
  return "";
};

const processRegistryModel = (model) => {
  // Extract model information from registry entry
  // Actual registry model structure:
  // - path: registry path (e.g., 'hf/repo/blob/hash/model.gguf')
  // - source: source identifier (e.g., 'hf')
  // - engine: the engine type (e.g., '@qvac/llm-llamacpp')
  // - quantization: quantization type (e.g., 'q4')
  // - params: model parameters (e.g., '2B')
  // - blobBinding: {
  //     coreKey: Buffer,
  //     blockOffset: number,
  //     blockLength: number,
  //     byteOffset: number,
  //     byteLength: number (file size),
  //     sha256: string (checksum)
  //   }

  const filename = model.path.split("/").pop() || model.path;
  const blobBinding = model.blobBinding || {};

  // Extract blob info
  const blobCoreKey = toHexString(blobBinding.coreKey);
  const blobBlockOffset = blobBinding.blockOffset ?? 0;
  const blobBlockLength = blobBinding.blockLength ?? 0;
  const blobByteOffset = blobBinding.byteOffset ?? 0;
  const expectedSize = blobBinding.byteLength ?? 0;
  const sha256Checksum = blobBinding.sha256 || "";

  // Get addon from engine, default to "other" if unknown
  const addon = getAddonFromEngine(model.engine) || "other";

  const result = {
    registryPath: model.path,
    registrySource: model.source,
    blobCoreKey,
    blobBlockOffset,
    blobBlockLength,
    blobByteOffset,
    modelId: filename,
    addon,
    expectedSize,
    sha256Checksum,
    engine: model.engine || "",
    modelName: extractModelName(model.path),
    quantization: model.quantization || "",
    params: model.params || "",
  };

  // Handle sharded models
  const shardInfo = detectShardedModel(filename);
  if (shardInfo.isSharded) {
    result.isShardPart = true;
    result.shardInfo = shardInfo;
  }

  return result;
};

// Extract a readable model name from the path
const extractModelName = (path) => {
  // Path format: 'source/repo/blob/hash/filename.gguf'
  // Try to extract repo name as model name
  const parts = path.split("/");
  if (parts.length >= 2) {
    // Return the second part (repo name) or first meaningful part
    return parts[1] || parts[0];
  }
  return (
    path
      .split("/")
      .pop()
      ?.replace(/\.\w+$/, "") || ""
  );
};

const groupShardedModels = (models) => {
  const shardGroups = new Map();
  const nonShardedModels = [];

  for (const model of models) {
    if (model.isShardPart) {
      const baseKey = `${model.registrySource}:${model.shardInfo.baseFilename}`;
      if (!shardGroups.has(baseKey)) {
        shardGroups.set(baseKey, []);
      }
      shardGroups.get(baseKey).push(model);
    } else {
      nonShardedModels.push(model);
    }
  }

  // Process shard groups
  const processedShards = [];
  for (const [baseKey, shards] of shardGroups) {
    // Sort shards by number
    shards.sort((a, b) => a.shardInfo.currentShard - b.shardInfo.currentShard);

    const firstShard = shards[0];
    const totalExpectedShards = firstShard.shardInfo.totalShards;

    if (shards.length !== totalExpectedShards) {
      console.warn(
        `⚠️  Expected ${totalExpectedShards} shards but found ${shards.length} for ${baseKey}`,
      );
    }

    // Calculate total size
    const totalSize = shards.reduce((sum, s) => sum + s.expectedSize, 0);

    // Build shard metadata
    const shardMetadata = shards.map((s) => ({
      filename: s.modelId,
      expectedSize: s.expectedSize,
      sha256Checksum: s.sha256Checksum,
      blobCoreKey: s.blobCoreKey,
      blobBlockOffset: s.blobBlockOffset,
      blobBlockLength: s.blobBlockLength,
      blobByteOffset: s.blobByteOffset,
    }));

    processedShards.push({
      ...firstShard,
      expectedSize: totalSize,
      shardMetadata,
      isShardPart: undefined,
      shardInfo: undefined,
    });
  }

  return [...nonShardedModels, ...processedShards];
};

const collectModels = async (options = {}) => {
  const { showDuplicates = false, noDedup = false } = options;
  const models = [];

  const client = new QVACRegistryClient({
    registryCoreKey:
      process.env.QVAC_REGISTRY_CORE_KEY || DEFAULT_REGISTRY_CORE_KEY,
  });

  try {
    // Wait for client to be ready
    await client.ready();

    // Fetch all models from registry
    const registryModels = await client.findModels({});

    console.log(`📦 Found ${registryModels.length} entries in registry`);

    for (const registryModel of registryModels) {
      const processed = processRegistryModel(registryModel);
      if (!processed) continue;
      models.push(processed);
    }
  } finally {
    await client.close();
  }

  // Group sharded models
  const groupedModels = groupShardedModels(models);

  // Skip deduplication if --no-dedup flag is set
  if (noDedup) {
    console.log(`\n⏭️  Skipping deduplication (--no-dedup flag set)`);
    return groupedModels;
  }

  // Deduplicate models by checksum (only if checksum is non-empty)
  const seenChecksums = new Map();
  const dedupedModels = [];
  const skipped = [];

  for (const model of groupedModels) {
    // Skip deduplication for models without a valid checksum
    if (!model.sha256Checksum || model.sha256Checksum === "") {
      dedupedModels.push(model);
      continue;
    }

    if (seenChecksums.has(model.sha256Checksum)) {
      skipped.push({
        name: model.registryPath,
        checksum: model.sha256Checksum,
        reason: `Duplicate of ${seenChecksums.get(model.sha256Checksum)}`,
      });
      continue;
    }

    seenChecksums.set(model.sha256Checksum, model.registryPath);
    dedupedModels.push(model);
  }

  if (skipped.length > 0) {
    console.log(`\n🧹 Removed ${skipped.length} duplicate model(s)`);
    if (showDuplicates) {
      skipped.forEach(({ name, checksum, reason }) => {
        console.log(`  - ${name}`);
        console.log(`    Checksum: ${checksum}`);
        console.log(`    ${reason}`);
      });
    } else {
      console.log(`   Use --show-duplicates to see details`);
    }
  }

  return dedupedModels;
};

const loadCurrentModels = () => {
  try {
    if (!fs.existsSync(OUTPUT_FILE)) {
      return [];
    }

    const content = fs.readFileSync(OUTPUT_FILE, "utf-8");
    const modelsMatch = content.match(
      /export const models = \[([\s\S]*?)\] as const/,
    );

    if (!modelsMatch) {
      return [];
    }

    // Extract model entries
    const modelsArrayContent = modelsMatch[1];
    const models = [];

    // Match each model object - look for registryPath (new format) or hyperbeeKey (old format)
    const modelRegex =
      /\{[^}]+name:\s*"([^"]+)"[^}]+(?:registryPath|hyperbeeKey):\s*"([^"]+)"[^}]+\}/g;
    let match;

    while ((match = modelRegex.exec(modelsArrayContent)) !== null) {
      models.push({
        name: match[1],
        registryPath: match[2],
      });
    }

    return models;
  } catch (error) {
    console.warn("⚠️  Could not load current models:", error.message);
    return [];
  }
};

const formatSize = (bytes) => {
  if (bytes < 1024) return `${bytes}B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)}KB`;
  if (bytes < 1024 * 1024 * 1024)
    return `${(bytes / (1024 * 1024)).toFixed(1)}MB`;
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(1)}GB`;
};

const getCommitHash = (short = false) => {
  try {
    const cmd = short ? "git rev-parse --short HEAD" : "git rev-parse HEAD";
    return execSync(cmd, { encoding: "utf-8" }).trim();
  } catch (error) {
    throw new Error("Git is required to generate history file", {
      cause: error,
    });
  }
};

const createHistoryFile = (added, removed, currentModels) => {
  if (added.length === 0 && removed.length === 0) {
    return null;
  }

  if (!fs.existsSync(HISTORY_DIR)) {
    fs.mkdirSync(HISTORY_DIR, { recursive: true });
  }

  const shortHash = getCommitHash(true);
  const fullHash = getCommitHash(false);
  const timestamp = new Date().toISOString();
  const filename = `${shortHash}.txt`;
  const filepath = `${HISTORY_DIR}/${filename}`;

  let content = `commit=${fullHash}\n`;
  content += `timestamp=${timestamp}\n`;
  content += `previous_count=${currentModels.length}\n`;
  content += `new_count=${currentModels.length + added.length - removed.length}\n`;
  content += `\n`;

  if (added.length > 0) {
    content += `[added]\n`;
    added.forEach((m) => {
      content += `${m.name}\n`;
    });
    content += `\n`;
  }

  if (removed.length > 0) {
    content += `[removed]\n`;
    removed.forEach((m) => {
      content += `${m.name}\n`;
    });
  }

  fs.writeFileSync(filepath, content);
  return filepath;
};

const compareModels = (remoteModels, currentModels) => {
  const currentPaths = new Set(currentModels.map((m) => m.registryPath));
  const remotePaths = new Set(remoteModels.map((m) => m.registryPath));

  const added = remoteModels.filter((m) => !currentPaths.has(m.registryPath));
  const removed = currentModels.filter((m) => !remotePaths.has(m.registryPath));

  return { added, removed };
};

const checkOnly = async (nonBlocking = false, showDuplicates = false) => {
  const timeoutMs = 30000;
  let timedOut = false;

  const timeoutPromise = new Promise((resolve) => {
    setTimeout(() => {
      timedOut = true;
      console.log("⏱️  Model check timed out");
      console.log("   Run 'bun check-models' manually to retry");
      resolve(null);
    }, timeoutMs);
  });

  try {
    const result = await Promise.race([
      (async () => {
        const remoteModels = await collectModels({
          showDuplicates,
        });
        const currentModels = loadCurrentModels();

        remoteModels.sort(
          (a, b) =>
            a.addon.localeCompare(b.addon) ||
            a.registryPath.localeCompare(b.registryPath),
        );

        return { remoteModels, currentModels };
      })(),
      timeoutPromise,
    ]);

    if (timedOut || !result) {
      process.exit(nonBlocking ? 0 : 1);
    }

    const { remoteModels, currentModels } = result;
    const { added, removed } = compareModels(remoteModels, currentModels);

    if (added.length === 0 && removed.length === 0) {
      console.log(`✅ Models are up to date (${remoteModels.length} models)`);
      process.exit(0);
    }

    console.log("");
    console.log("━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━");

    if (added.length > 0) {
      console.log(
        `✨ ${added.length} new model${added.length === 1 ? "" : "s"} available:`,
      );
      const usedNames = new Set();
      added.slice(0, 10).forEach((m) => {
        const name = generateExportName({
          path: m.registryPath,
          engine: m.engine,
          name: m.modelName,
          quantization: m.quantization,
          usedNames,
        });
        console.log(`  + ${name} (${m.addon}, ${formatSize(m.expectedSize)})`);
      });
      if (added.length > 10) {
        console.log(`  ... and ${added.length - 10} more`);
      }
    }

    if (removed.length > 0) {
      console.log(
        `\n⚠️  ${removed.length} model${removed.length === 1 ? "" : "s"} removed:`,
      );
      removed.slice(0, 5).forEach((m) => {
        console.log(`  - ${m.name}`);
      });
      if (removed.length > 5) {
        console.log(`  ... and ${removed.length - 5} more`);
      }
    }

    console.log("");
    console.log(`💡 Run 'bun update-models' to sync changes`);
    console.log("");
    if (nonBlocking) {
      console.log("💡 Commit will proceed - update models when ready");
    }
    console.log("━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━");
    console.log("");

    // In non-blocking mode, exit 0 even if updates exist
    // In normal mode, exit 1 to indicate updates available
    process.exit(nonBlocking ? 0 : 1);
  } catch (error) {
    console.error("❌ Model check failed:", error.message);
    process.exit(nonBlocking ? 0 : 1);
  }
};

const updateModels = async (showDuplicates = false, noDedup = false) => {
  console.log("🔄 Fetching models from QVAC Registry...\n");

  // Load current models to track changes
  const currentModels = loadCurrentModels();

  const models = await collectModels({
    showDuplicates,
    noDedup,
  });

  // Compare to find added/removed for history tracking
  const { added, removed } = compareModels(models, currentModels);

  // Sort models by addon and then by path
  models.sort(
    (a, b) =>
      a.addon.localeCompare(b.addon) ||
      a.registryPath.localeCompare(b.registryPath),
  );

  // Write models file
  fs.writeFileSync(OUTPUT_FILE, generateModelsFileContent(models));

  // Format file with prettier
  try {
    execSync(`npx prettier --write "${OUTPUT_FILE}"`, { stdio: "pipe" });
  } catch {}

  console.log(`✅ Generated ${models.length} models → ${OUTPUT_FILE}`);

  // Create history file if there are changes
  const usedNamesForHistory = new Set();
  const addedWithNames = added.map((m) => ({
    ...m,
    name: generateExportName({
      path: m.registryPath,
      engine: m.engine,
      name: m.modelName,
      quantization: m.quantization,
      usedNames: usedNamesForHistory,
    }),
  }));

  if (added.length > 0 || removed.length > 0) {
    const historyFile = createHistoryFile(
      addedWithNames,
      removed,
      currentModels,
    );
    if (historyFile) {
      console.log(`📜 Created history file → ${historyFile}`);
      console.log(`   Added: ${added.length}, Removed: ${removed.length}`);
    }
  }
};

const main = async () => {
  const CHECK_ONLY = process.argv.includes("--check");
  const NON_BLOCKING = process.argv.includes("--non-blocking");
  const SHOW_DUPLICATES = process.argv.includes("--show-duplicates");
  const NO_DEDUP = process.argv.includes("--no-dedup");

  if (CHECK_ONLY) {
    await checkOnly(NON_BLOCKING, SHOW_DUPLICATES);
  } else {
    await updateModels(SHOW_DUPLICATES, NO_DEDUP);
  }
};

main().catch(console.error);
