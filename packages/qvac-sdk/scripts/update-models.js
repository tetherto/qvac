import b4a from "b4a";
import Hyperbee from "hyperbee";
import Corestore from "corestore";
import Hyperswarm from "hyperswarm";
import fs from "fs";
import { fileURLToPath } from "url";
import { execSync } from "child_process";

const HYPERBEE_KEY =
  "d4aca756436ff6429e3ecaa008b0a8023fa8ea568192149a09f212d5013af865";
const OUTPUT_FILE = fileURLToPath(
  new URL("../models/hyperdrive/models.ts", import.meta.url),
);
const HISTORY_DIR = fileURLToPath(
  new URL("../models/history", import.meta.url),
);

// Maps hyperbee category to canonical model type (engine-usecase format)
// Used internally in script for logic (extractMainModel, generateExportName)
const ADDON_MAP = {
  generation: "llamacpp-completion",
  transcription: "whispercpp-transcription",
  embedding: "llamacpp-embedding",
  translation: "nmtcpp-translation",
  vad: "vad", // VAD stays as-is (special case, not a model type)
  tts: "onnx-tts",
  ocr: "onnx-ocr",
};

// Maps canonical to alias for output in models.ts (backward compat)
const CANONICAL_TO_ALIAS = {
  "llamacpp-completion": "llm",
  "whispercpp-transcription": "whisper",
  "llamacpp-embedding": "embeddings",
  "nmtcpp-translation": "nmt",
  vad: "vad",
  "onnx-tts": "tts",
  "onnx-ocr": "ocr",
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

const extractMainModel = (driveMetadata, addon, hyperbeeKey) => {
  // Special handling for bergamot translation models
  if (addon === "nmtcpp-translation" && hyperbeeKey?.includes("bergamot")) {
    const modelFiles = driveMetadata.filter(
      (f) =>
        f.filename.startsWith("model.") &&
        f.filename.endsWith(".intgemm.alphas.bin"),
    );
    const vocabFiles = driveMetadata.filter(
      (f) =>
        f.filename.endsWith(".spm") &&
        (f.filename.startsWith("vocab.") ||
          f.filename.startsWith("srcvocab.") ||
          f.filename.startsWith("trgvocab.")),
    );

    const results = [];

    // Add each model file as a separate entry
    modelFiles.forEach((modelFile) => {
      results.push({
        modelId: modelFile.filename,
        expectedSize: modelFile.expectedSize,
        sha256Checksum: modelFile.checksum || "",
      });
    });

    // Add each vocab file as a separate entry
    vocabFiles.forEach((vocabFile) => {
      results.push({
        modelId: vocabFile.filename,
        expectedSize: vocabFile.expectedSize,
        sha256Checksum: vocabFile.checksum || "",
      });
    });

    return results;
  }

  let modelFiles = driveMetadata.filter(
    (f) =>
      f.filename.endsWith(".gguf") ||
      f.filename.endsWith(".bin") ||
      f.filename.endsWith(".onnx"),
  );

  if (modelFiles.length > 1) {
    modelFiles = modelFiles.filter((f) => !f.filename.includes("silero"));
  }

  // Check for sharded models
  const shardedFiles = modelFiles.filter(
    (f) => detectShardedModel(f.filename).isSharded,
  );

  if (shardedFiles.length > 0) {
    // Sort shards by number
    shardedFiles.sort((a, b) => {
      const aInfo = detectShardedModel(a.filename);
      const bInfo = detectShardedModel(b.filename);
      return aInfo.currentShard - bInfo.currentShard;
    });

    const firstShard = shardedFiles[0];
    const shardInfo = detectShardedModel(firstShard.filename);

    if (shardedFiles.length !== shardInfo.totalShards) {
      console.warn(
        `Warning: Expected ${shardInfo.totalShards} shards but found ${shardedFiles.length} for ${firstShard.filename}`,
      );
    }

    const tensorsFile = driveMetadata.find(
      (f) => f.filename === `${shardInfo.baseFilename}.tensors.txt`,
    );

    let totalSize = shardedFiles.reduce(
      (sum, file) => sum + file.expectedSize,
      0,
    );
    if (tensorsFile) {
      totalSize += tensorsFile.expectedSize;
    }

    // Build shardMetadata array
    const shardMetadata = shardedFiles.map((file) => ({
      filename: file.filename,
      expectedSize: file.expectedSize,
      sha256Checksum: file.checksum || "",
    }));

    // Add tensors file if present
    if (tensorsFile) {
      shardMetadata.push({
        filename: tensorsFile.filename,
        expectedSize: tensorsFile.expectedSize,
        sha256Checksum: tensorsFile.checksum || "",
      });
    }

    return [
      {
        modelId: firstShard.filename,
        expectedSize: totalSize,
        sha256Checksum: shardMetadata[0].sha256Checksum,
        shardMetadata,
      },
    ];
  }

  // for OCR models (multiple onnx files: detector + recognizer)
  if (addon === "onnx-ocr" && modelFiles.length >= 2) {
    return modelFiles.map((f) => ({
      modelId: f.filename,
      expectedSize: f.expectedSize,
      sha256Checksum: f.checksum,
    }));
  }

  // for TTS models (onnx + config.json)
  if (
    addon === "onnx-tts" &&
    modelFiles.length === 1 &&
    modelFiles[0].filename.endsWith(".onnx")
  ) {
    const onnxFile = modelFiles[0];
    const configFile = driveMetadata.find((f) => f.filename === "config.json");

    if (configFile) {
      return [
        {
          modelId: onnxFile.filename,
          expectedSize: onnxFile.expectedSize,
          sha256Checksum: onnxFile.checksum,
        },
        {
          modelId: configFile.filename,
          expectedSize: configFile.expectedSize,
          sha256Checksum: configFile.checksum,
        },
      ];
    }

    return [
      {
        modelId: onnxFile.filename,
        expectedSize: onnxFile.expectedSize,
        sha256Checksum: onnxFile.checksum,
      },
    ];
  }

  if (modelFiles.length === 1) {
    return [
      {
        modelId: modelFiles[0].filename,
        expectedSize: modelFiles[0].expectedSize,
        sha256Checksum: modelFiles[0].checksum,
      },
    ];
  }

  // for projection models
  if (
    modelFiles.length === 2 &&
    modelFiles.some((f) => f?.filename?.includes("mmproj"))
  ) {
    return modelFiles.map((f) => ({
      modelId: f.filename,
      expectedSize: f.expectedSize,
      sha256Checksum: f.checksum,
    }));
  }

  return [];
};

const generateExportName = ({ modelId, hyperbeeKey, usedNames, addon }) => {
  // hyperbeeKey format: function:name:type:version:size:quant:internal:other
  const parts = hyperbeeKey.split(":");
  const [functionField, modelName, type, version, size, quant] = parts;

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

  let name = "";

  if (addon === "whispercpp-transcription") {
    // WHISPER models: WHISPER_[language_]<type>_<version>_<quant>
    const nameParts = [type, version, quant].filter((p) => p && p !== "");

    // Check if this is a language-specific model (not the base "whisper")
    if (modelName !== "whisper") {
      const variant = parts[parts.length - 1];
      const languageId = modelName.startsWith("whisper-")
        ? modelName.replace("whisper-", "")
        : variant;
      if (languageId && languageId !== "") {
        nameParts.unshift(languageId);
      }
    }

    name = `WHISPER_${nameParts.map(cleanPart).join("_")}`;
  } else if (functionField === "vad") {
    // VAD models: VAD_<type>_<version>
    // Use type (e.g., "silero") instead of full name to avoid redundancy
    const nameParts = [type || modelName, version].filter((p) => p && p !== "");
    name = `VAD_${nameParts.map(cleanPart).join("_")}`;
  } else if (functionField === "translation") {
    const langPair = parts[parts.length - 1];

    if (modelName.includes("bergamot")) {
      // BERGAMOT: Handle both model and vocab files
      const modelMatch = modelId.match(
        /^model\.([^.]+)\.intgemm\.alphas\.bin$/,
      );
      if (modelMatch) {
        const bergamotLangPair = modelMatch[1];
        name = `BERGAMOT_${cleanPart(bergamotLangPair.replace("-", "_"))}`;
      } else if (modelId.endsWith(".spm")) {
        // Handle vocab files
        const vocabMatch = modelId.match(
          /^(vocab|srcvocab|trgvocab)\.([^.]+)\.spm$/,
        );
        if (vocabMatch) {
          const [, vocabType, bergamotLangPair] = vocabMatch;
          const vocabPrefix =
            vocabType === "vocab" ? "VOCAB" : vocabType.toUpperCase();
          name = `BERGAMOT_${cleanPart(bergamotLangPair.replace("-", "_"))}_${vocabPrefix}`;
        }
      }
    } else if (modelName.includes("indictrans")) {
      // INDICTRANS: MARIAN_<lang-pair>_INDIC_<size>_<quant>
      name = `MARIAN_${cleanPart(langPair.replace("-", "_"))}_INDIC_${cleanPart(size)}_${cleanPart(quant)}`;
    } else if (modelName.includes("marian")) {
      // MARIAN: MARIAN_[OPUS_]<lang-pair>_<quant>
      const hasOpus = type && type.includes("opus");
      const prefix = hasOpus ? "MARIAN_OPUS" : "MARIAN";
      name = `${prefix}_${cleanPart(langPair.replace("-", "_"))}_${cleanPart(quant)}`;
    }
  } else if (functionField === "generation") {
    // LLM models: <name>_<version>_<size>_<type>_<quant>
    const nameParts = [modelName, version, size, type, quant].filter(
      (p) => p && p !== "",
    );
    name = nameParts.map(cleanPart).join("_");
    if (modelId.includes("mmproj")) {
      name = "MMPROJ_" + name;
    }
  } else if (functionField === "embedding") {
    // Embeddings: <name>_<size>_<quant>
    const nameParts = [modelName, size, quant].filter((p) => p && p !== "");
    name = nameParts.map(cleanPart).join("_");
  } else if (functionField === "tts") {
    // TTS models: TTS_<name>_<language>_<type>
    const language = parts[parts.length - 1];
    const nameParts = [modelName, language, type].filter((p) => p && p !== "");
    name = `TTS_${nameParts.map(cleanPart).join("_")}`;
    if (modelId.includes("config.json")) {
      name = name + "_CONFIG";
    }
  } else if (addon === "onnx-ocr") {
    // OCR models: OCR_<name>_<language>_<DETECTOR|RECOGNIZER>
    // Extract type from filename instead of hyperbeeKey since files have different types
    const language = parts[parts.length - 1];
    let fileType = "";

    if (modelId.includes("detector")) {
      fileType = "DETECTOR";
    } else if (modelId.includes("recognizer")) {
      fileType = "RECOGNIZER";
    }

    const nameParts = [modelName, language, fileType].filter(
      (p) => p && p !== "",
    );
    name = `OCR_${nameParts.map(cleanPart).join("_")}`;
  } else {
    // Generic fallback
    const nameParts = [modelName, type, version, size, quant].filter(
      (p) => p && p !== "",
    );
    name = nameParts.map(cleanPart).join("_");
  }

  name = name.replace(/^_+|_+$/g, "");

  // Add SHARD suffix for sharded models
  if (detectShardedModel(modelId).isSharded) {
    name = `${name}_SHARD`;
  }

  let finalName = name;
  let counter = 1;
  while (usedNames.has(finalName)) {
    finalName = `${name}_${counter++}`;
  }
  usedNames.add(finalName);

  return finalName;
};

const generateFileContent = (models) => {
  const usedNames = new Set();

  // Generate names first pass to add to model objects
  const modelsWithNames = models.map((m) => ({
    ...m,
    name: generateExportName({
      modelId: m.modelId,
      hyperbeeKey: m.hyperbeeKey,
      addon: m.addon,
      usedNames,
    }),
  }));

  return generateFileContentWithNames(modelsWithNames);
};

const generateFileContentWithNames = (modelsWithNames) => {
  const entries = modelsWithNames
    .map((m) => {
      const addonAlias = CANONICAL_TO_ALIAS[m.addon] || m.addon;
      let entry = `  {
    name: "${m.name}",
    hyperdriveKey: "${m.hyperdriveKey}",
    hyperbeeKey: "${m.hyperbeeKey}",
    modelId: "${m.modelId}",
    addon: "${addonAlias}",
    expectedSize: ${m.expectedSize},
    sha256Checksum: "${m.sha256Checksum}"`;

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
  src: \`pear://\${models[${i}].hyperdriveKey}/\${models[${i}].modelId}\`,
  modelId: models[${i}].modelId,
  hyperdriveKey: models[${i}].hyperdriveKey,
  hyperbeeKey: models[${i}].hyperbeeKey,
  expectedSize: models[${i}].expectedSize,
  sha256Checksum: models[${i}].sha256Checksum,
  addon: models[${i}].addon,
} as const;`;
    })
    .join("\n\n");

  return `// THIS FILE IS AUTO-GENERATED BY scripts/update-models.js
// DO NOT MODIFY MANUALLY

export type HyperdriveItem = {
  name: string;
  hyperdriveKey: string;
  hyperbeeKey: string;
  modelId: string;
  addon: "llm" | "whisper" | "embeddings" | "nmt" | "vad" | "tts" | "ocr";
  expectedSize: number;
  sha256Checksum: string;
  shardMetadata?: readonly { filename: string; expectedSize: number; sha256Checksum: string }[];
};

export type ModelConstant = {
  name: string;
  src: string;
  modelId: string;
  hyperdriveKey: string;
  hyperbeeKey: string;
  expectedSize: number;
  sha256Checksum: string;
  addon: "llm" | "whisper" | "embeddings" | "nmt" | "vad" | "tts" | "ocr";
};

export const models = [
${entries}
] as const satisfies readonly HyperdriveItem[];

// Individual model constants for direct import/use with loadModel
// These contain all metadata and can be used directly: loadModel({ modelSrc: WHISPER_TINY, ... })
${exports}

// Helper function to get model by name
export function getModelByName(name: string): HyperdriveItem | undefined {
  return models.find((model) => model.name === name);
}

// Helper function for our curated model list (deprecated, use getModelByName)
export function getModelBySrc(modelId: string, hyperdriveKey: string): HyperdriveItem | undefined {
  return models.find((model) => model.modelId === modelId && model.hyperdriveKey === hyperdriveKey);
}
`;
};

const collectModels = async (options = {}) => {
  const store = new Corestore("./temp-storage");
  const swarm = new Hyperswarm();
  const models = [];
  const { showDuplicates = false } = options;

  try {
    await store.ready();
    swarm.on("connection", (conn) => store.replicate(conn));

    const core = store.get({ key: b4a.from(HYPERBEE_KEY, "hex") });
    await core.ready();
    swarm.join(core.discoveryKey);
    await swarm.flush();

    const db = new Hyperbee(core, {
      keyEncoding: "utf-8",
      valueEncoding: "json",
    });

    for await (const { key, value } of db.createReadStream()) {
      const addon = ADDON_MAP[value.tags?.function];
      if (!addon || !value.driveMetadata) continue;

      const metadataArr = extractMainModel(value.driveMetadata, addon, key);
      if (metadataArr.length === 0) continue;

      metadataArr.forEach((metadata) => {
        models.push({
          hyperdriveKey: value.key,
          hyperbeeKey: key,
          addon,
          ...metadata,
        });
      });
    }

    await db.close();
  } finally {
    await store.close();
    await swarm.destroy();
    if (fs.existsSync("./temp-storage")) {
      fs.rmSync("./temp-storage", { recursive: true, force: true });
    }
  }

  // Deduplicate models by checksum
  const seenChecksums = new Map();
  const dedupedModels = [];
  const skipped = [];

  for (const model of models) {
    if (seenChecksums.has(model.sha256Checksum)) {
      skipped.push({
        name: model.hyperbeeKey,
        reason: `Duplicate of ${seenChecksums.get(model.sha256Checksum)}`,
      });
      continue;
    }

    seenChecksums.set(model.sha256Checksum, model.hyperbeeKey);
    dedupedModels.push(model);
  }

  if (skipped.length > 0) {
    console.log(`\n🧹 Removed ${skipped.length} duplicate model(s)`);
    if (showDuplicates) {
      skipped.forEach(({ name, reason }) => {
        console.log(`  - ${name} (${reason})`);
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

    // Extract model entries using a more robust regex that captures all fields
    const modelsArrayContent = modelsMatch[1];
    const models = [];

    // Match each model object in the array with all fields
    const modelRegex =
      /\{\s*name:\s*"([^"]+)",\s*hyperdriveKey:\s*"([^"]+)",\s*hyperbeeKey:\s*"([^"]+)",\s*modelId:\s*"([^"]+)",\s*addon:\s*"([^"]+)",\s*expectedSize:\s*(\d+),\s*sha256Checksum:\s*"([^"]*)"/g;
    let match;

    while ((match = modelRegex.exec(modelsArrayContent)) !== null) {
      models.push({
        name: match[1],
        hyperdriveKey: match[2],
        hyperbeeKey: match[3],
        modelId: match[4],
        addon: match[5],
        expectedSize: parseInt(match[6], 10),
        sha256Checksum: match[7],
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
  // Use composite key: hyperbeeKey + modelId to handle multi-file models correctly
  const makeKey = (m) => `${m.hyperbeeKey}:${m.modelId}`;
  const currentKeys = new Set(currentModels.map(makeKey));
  const remoteKeys = new Set(remoteModels.map(makeKey));

  const added = remoteModels.filter((m) => !currentKeys.has(makeKey(m)));
  const removed = currentModels.filter((m) => !remoteKeys.has(makeKey(m)));

  return { added, removed };
};

const checkOnly = async (nonBlocking = false, showDuplicates = false) => {
  const timeoutMs = 15000;
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
        const remoteModels = await collectModels({ showDuplicates });
        const currentModels = loadCurrentModels();

        remoteModels.sort(
          (a, b) =>
            a.addon.localeCompare(b.addon) ||
            a.hyperbeeKey.localeCompare(b.hyperbeeKey),
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
      console.log(`Models are up to date (${remoteModels.length} models)`);
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
          modelId: m.modelId,
          hyperbeeKey: m.hyperbeeKey,
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

const updateModels = async (showDuplicates = false) => {
  // Load current models to preserve existing names
  const currentModels = loadCurrentModels();
  const currentModelMap = new Map(
    currentModels.map((m) => [`${m.hyperbeeKey}:${m.modelId}`, m]),
  );

  // Collect remote models
  const remoteModels = await collectModels({ showDuplicates });

  // Compare to find added/removed
  const { added, removed } = compareModels(remoteModels, currentModels);

  // Build final models list preserving existing names
  const usedNames = new Set();
  const finalModels = remoteModels.map((remote) => {
    const key = `${remote.hyperbeeKey}:${remote.modelId}`;
    const existing = currentModelMap.get(key);

    if (existing) {
      // Preserve existing name, but update other fields from remote
      usedNames.add(existing.name);
      return {
        ...remote,
        name: existing.name,
      };
    }

    // New model - generate name
    const name = generateExportName({
      modelId: remote.modelId,
      hyperbeeKey: remote.hyperbeeKey,
      addon: remote.addon,
      usedNames,
    });
    return {
      ...remote,
      name,
    };
  });

  finalModels.sort(
    (a, b) =>
      a.addon.localeCompare(b.addon) ||
      a.hyperbeeKey.localeCompare(b.hyperbeeKey),
  );

  // Generate names for added models (for history file)
  const usedNamesForAdded = new Set();
  const addedWithNames = added.map((m) => ({
    ...m,
    name: generateExportName({
      modelId: m.modelId,
      hyperbeeKey: m.hyperbeeKey,
      addon: m.addon,
      usedNames: usedNamesForAdded,
    }),
  }));

  // Write the models file
  fs.writeFileSync(OUTPUT_FILE, generateFileContentWithNames(finalModels));

  try {
    execSync(`npx prettier --write "${OUTPUT_FILE}"`, { stdio: "pipe" });
  } catch {}

  console.log(`✅ Generated ${finalModels.length} models → ${OUTPUT_FILE}`);

  // Create history file if there are changes
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

  if (CHECK_ONLY) {
    await checkOnly(NON_BLOCKING, SHOW_DUPLICATES);
  } else {
    await updateModels(SHOW_DUPLICATES);
  }
};

main().catch(console.error);
