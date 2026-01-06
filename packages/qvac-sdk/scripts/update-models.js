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

const ADDON_MAP = {
  generation: "llm",
  transcription: "whisper",
  embedding: "embeddings",
  translation: "nmt",
  vad: "vad",
  tts: "tts",
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

const extractMainModel = (driveMetadata, addon) => {
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

  // for TTS models (onnx + config.json)
  if (
    addon === "tts" &&
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

const generateExportName = ({ modelId, hyperbeeKey, usedNames }) => {
  // hyperbeeKey format: function:name:type:version:size:quant:internal:other
  const parts = hyperbeeKey.split(":");
  const [addon, modelName, type, version, size, quant] = parts;

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

  if (addon === "transcription") {
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
  } else if (addon === "vad") {
    // VAD models: VAD_<type>_<version>
    // Use type (e.g., "silero") instead of full name to avoid redundancy
    const nameParts = [type || modelName, version].filter((p) => p && p !== "");
    name = `VAD_${nameParts.map(cleanPart).join("_")}`;
  } else if (addon === "translation") {
    const langPair = parts[parts.length - 1];

    if (modelName.includes("indictrans")) {
      // INDICTRANS: MARIAN_<lang-pair>_INDIC_<size>_<quant>
      name = `MARIAN_${cleanPart(langPair.replace("-", "_"))}_INDIC_${cleanPart(size)}_${cleanPart(quant)}`;
    } else if (modelName.includes("marian")) {
      // MARIAN: MARIAN_[OPUS_]<lang-pair>_<quant>
      const hasOpus = type && type.includes("opus");
      const prefix = hasOpus ? "MARIAN_OPUS" : "MARIAN";
      name = `${prefix}_${cleanPart(langPair.replace("-", "_"))}_${cleanPart(quant)}`;
    }
  } else if (addon === "generation") {
    // LLM models: <name>_<version>_<size>_<type>_<quant>
    const nameParts = [modelName, version, size, type, quant].filter(
      (p) => p && p !== "",
    );
    name = nameParts.map(cleanPart).join("_");
    if (modelId.includes("mmproj")) {
      name = "MMPROJ_" + name;
    }
  } else if (addon === "embedding") {
    // Embeddings: <name>_<size>_<quant>
    const nameParts = [modelName, size, quant].filter((p) => p && p !== "");
    name = nameParts.map(cleanPart).join("_");
  } else if (addon === "tts") {
    // TTS models: TTS_<name>_<language>_<type>
    const language = parts[parts.length - 1];
    const nameParts = [modelName, language, type].filter((p) => p && p !== "");
    name = `TTS_${nameParts.map(cleanPart).join("_")}`;
    if (modelId.includes("config.json")) {
      name = name + "_CONFIG";
    }
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
      usedNames,
    }),
  }));

  const entries = modelsWithNames
    .map((m) => {
      let entry = `  {
    name: "${m.name}",
    hyperdriveKey: "${m.hyperdriveKey}",
    hyperbeeKey: "${m.hyperbeeKey}",
    modelId: "${m.modelId}",
    addon: "${m.addon}",
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
  addon: "llm" | "whisper" | "embeddings" | "nmt" | "vad" | "tts";
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
  addon: "llm" | "whisper" | "embeddings" | "nmt" | "vad" | "tts";
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
      const addon = ADDON_MAP[value.tags.function];
      if (!addon || !value.driveMetadata) continue;

      const metadataArr = extractMainModel(value.driveMetadata, addon);
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

    // Extract model entries using a more robust regex
    const modelsArrayContent = modelsMatch[1];
    const models = [];

    // Match each model object in the array
    const modelRegex =
      /\{[^}]+name:\s*"([^"]+)"[^}]+hyperbeeKey:\s*"([^"]+)"[^}]+\}/g;
    let match;

    while ((match = modelRegex.exec(modelsArrayContent)) !== null) {
      models.push({
        name: match[1],
        hyperbeeKey: match[2],
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

const compareModels = (remoteModels, currentModels) => {
  const currentKeys = new Set(currentModels.map((m) => m.hyperbeeKey));
  const remoteKeys = new Set(remoteModels.map((m) => m.hyperbeeKey));

  const added = remoteModels.filter((m) => !currentKeys.has(m.hyperbeeKey));
  const removed = currentModels.filter((m) => !remoteKeys.has(m.hyperbeeKey));

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
  const models = await collectModels({ showDuplicates });

  models.sort(
    (a, b) =>
      a.addon.localeCompare(b.addon) ||
      a.hyperbeeKey.localeCompare(b.hyperbeeKey),
  );

  fs.writeFileSync(OUTPUT_FILE, generateFileContent(models));

  try {
    execSync(`npx prettier --write "${OUTPUT_FILE}"`, { stdio: "pipe" });
  } catch {}

  console.log(`✅ Generated ${models.length} models → ${OUTPUT_FILE}`);
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
