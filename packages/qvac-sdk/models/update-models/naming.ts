import { getAddonFromEngine } from "../../schemas/engine-addon-map";
import type { ModelRegistryEngine } from "../../schemas/registry";
import { detectShardedModel } from "./shards";
import type { ExportNameInput } from "./types";

// Normalizes a name part to a valid JS export name fragment.
// Strips ggml/gguf prefixes, shortens "instruct" to "inst",
// and uppercases with underscore separators.
export function cleanPart(p: string): string {
  if (!p) return "";
  return p
    .replace(/ggml-?/gi, "")
    .replace(/gguf-?/gi, "")
    .replace(/instruct/gi, "inst")
    .replace(/^-+|-+$/g, "")
    .toUpperCase()
    .replace(/[^A-Z0-9]+/g, "_");
}

// Generates a unique export constant name for a model based on its
// registry metadata, engine type, tags, and filename.
export function generateExportName({
  path: registryPath,
  engine,
  name: modelName,
  quantization,
  params,
  tags,
  usedNames,
}: ExportNameInput): string {
  let addon = getAddonFromEngine(engine);

  // Override addon classification when tags clearly indicate a different type.
  // e.g. SmolVLM2 f16 uses translation-llamacpp engine (→nmt) but is actually a multimodal LLM.
  if (
    addon === "nmt" &&
    tags.some((t) => t === "generation" || t === "multimodal")
  ) {
    addon = "llm";
  }

  let exportName = "";

  const filename = decodeURIComponent(
    registryPath.split("/").pop() || registryPath,
  );
  const lowerFilename = filename.toLowerCase();
  const lowerPath = registryPath.toLowerCase();

  // Extract structured info from tags array.
  // Tags typically contain: [function, type, modelName, langPair/other]
  const tagType = tags[1] || "";
  const tagName = tags[2] || "";
  const tagExtra = tags[3] || "";

  exportName = generateBaseName({
    addon,
    engine,
    filename,
    lowerFilename,
    lowerPath,
    modelName,
    quantization,
    params,
    tagType,
    tagName,
    tagExtra,
    tags,
  });

  exportName = exportName.replace(/^_+|_+$/g, "").replace(/_+/g, "_");

  // Add suffix for metadata files (tensors.txt are shard metadata, not actual models)
  if (lowerFilename.endsWith(".tensors.txt")) {
    exportName = `${exportName}_TENSORS`;
  }

  // Add SHARD suffix for sharded models
  if (detectShardedModel(filename).isSharded) {
    exportName = `${exportName}_SHARD`;
  }

  return resolveCollision(exportName, quantization, usedNames);
}

// Resolves name collisions by appending quantization or a sequential counter.
function resolveCollision(
  exportName: string,
  quantization: string,
  usedNames: Set<string>,
): string {
  let finalName = exportName || "UNKNOWN_MODEL";

  if (usedNames.has(finalName) && quantization) {
    const cleanedQuant = cleanPart(quantization);
    // Only append quantization if it's not already at the end of the name
    if (cleanedQuant && !exportName.endsWith(cleanedQuant)) {
      const withQuant = `${exportName}_${cleanedQuant}`;
      if (!usedNames.has(withQuant)) {
        finalName = withQuant;
      }
    }
  }

  let counter = 1;
  while (usedNames.has(finalName)) {
    finalName = `${exportName}_${counter++}`;
  }

  usedNames.add(finalName);
  return finalName;
}

// --- Per-addon naming strategies ---

interface BaseNameInput {
  addon: string;
  engine: ModelRegistryEngine;
  filename: string;
  lowerFilename: string;
  lowerPath: string;
  modelName: string;
  quantization: string;
  params: string;
  tagType: string;
  tagName: string;
  tagExtra: string;
  tags: string[];
}

function generateBaseName(input: BaseNameInput): string {
  const { addon, lowerFilename } = input;

  // Detect VAD Silero before whisper (same engine, different model type)
  if (lowerFilename.includes("silero")) {
    return generateVadSileroName(input);
  }

  switch (addon) {
    case "whisper":
      return generateWhisperName(input);
    case "vad":
      return generateVadName(input);
    case "nmt":
      return generateNmtName(input);
    case "llm":
      return generateLlmName(input);
    case "embeddings":
      return generateEmbeddingsName(input);
    case "tts":
      return generateTtsName(input);
    case "ocr":
      return generateOcrName(input);
    default:
      return cleanPart(input.filename.replace(/\.\w+$/, ""));
  }
}

function generateVadSileroName({ filename }: BaseNameInput): string {
  const versionMatch = filename.match(/v(\d+\.\d+\.\d+)/i);
  const version = versionMatch ? versionMatch[1]! : "";
  const nameParts = ["SILERO", version].filter((p) => p && p !== "");
  return `VAD_${nameParts.map(cleanPart).join("_")}`;
}

function generateWhisperName({
  filename,
  lowerFilename,
  quantization,
}: BaseNameInput): string {
  // Extract language from filename prefix (e.g. "de-tiny-ggml-model-f16.bin")
  const langPrefixMatch = filename.match(/^([a-z]{2})-/i);
  // Detect English-only models from ".en" or ".en-" in filename
  const isEnglishOnly =
    /\.en[-.]/.test(lowerFilename) || lowerFilename.endsWith(".en.bin");

  // Extract size from filename
  const sizeMatch = filename.match(
    /\b(tiny|base|small|medium|large(?:-v[0-9]+)?(?:-turbo)?)\b/i,
  );
  const modelSize = sizeMatch ? sizeMatch[1]! : "";

  // Extract quant from filename (f16, q8_0, etc.)
  const quantMatch = filename.match(/[-_](f16|q[0-9]+[_][0-9]+|q8)\b/i);
  const fileQuant = quantMatch ? quantMatch[1]! : quantization;

  const nameParts: string[] = [];

  if (langPrefixMatch) {
    const langCode = langPrefixMatch[1]!.toLowerCase();
    const langMap: Record<string, string> = {
      de: "GERMAN",
      es: "SPANISH",
      fr: "FRENCH",
      it: "ITALIAN",
      ja: "JAPANESE",
      pt: "PORTUGUESE",
      ru: "RUSSIAN",
      nb: "NORWEGIAN",
      en: "ENGLISH",
    };
    const langName = langMap[langCode] || langCode.toUpperCase();
    nameParts.push(langName);
  } else if (isEnglishOnly) {
    nameParts.push("EN");
  }

  if (modelSize) nameParts.push(modelSize);
  if (fileQuant) nameParts.push(fileQuant);

  return `WHISPER_${nameParts.map(cleanPart).join("_")}`;
}

function generateVadName({
  filename,
  tagType,
  tagName,
}: BaseNameInput): string {
  const versionMatch = filename.match(/v(\d+\.\d+\.\d+)/i);
  const version = versionMatch ? versionMatch[1]! : "";
  const typeName = tagType || tagName || "SILERO";
  const nameParts = [typeName, version].filter((p) => p && p !== "");
  return `VAD_${nameParts.map(cleanPart).join("_")}`;
}

function generateNmtName(input: BaseNameInput): string {
  const { lowerPath, lowerFilename } = input;

  if (
    lowerPath.includes("salamandra") ||
    lowerFilename.includes("salamandra")
  ) {
    return generateNmtSalamandraName(input);
  }
  if (
    lowerPath.includes("indictrans") ||
    lowerFilename.includes("indictrans")
  ) {
    return generateNmtIndictransName(input);
  }
  if (lowerPath.includes("opus") || lowerFilename.includes("opus")) {
    return generateNmtOpusName(input);
  }
  if (lowerPath.includes("bergamot") || lowerFilename.includes("bergamot")) {
    return generateNmtBergamotName(input);
  }

  const nameParts = [input.modelName, input.quantization].filter(
    (p) => p && p !== "",
  );
  return `NMT_${nameParts.map(cleanPart).join("_")}`;
}

function generateNmtSalamandraName({ filename }: BaseNameInput): string {
  const base = filename.replace(/\.\w+$/, "").replace(/-\d{5}-of-\d{5}/, "");
  return cleanPart(base);
}

function generateNmtIndictransName({
  filename,
  quantization,
}: BaseNameInput): string {
  const langMatch = filename.match(/(en-indic|indic-en|indic-indic)/i);
  const langDir = langMatch ? langMatch[1]! : "";
  const langMap: Record<string, string> = {
    "en-indic": "EN_HI",
    "indic-en": "HI_EN",
    "indic-indic": "HI_HI",
  };
  const langPair = langMap[langDir.toLowerCase()] || cleanPart(langDir);

  const sizeMatch = filename.match(/(\d+[MB])/i);
  const size = sizeMatch ? sizeMatch[1]! : "";

  const nameParts = [langPair, "INDIC", size, quantization].filter(
    (p) => p && p !== "",
  );
  return `MARIAN_${nameParts.map(cleanPart).join("_")}`;
}

function generateNmtOpusName({
  filename,
  quantization,
  tagExtra,
}: BaseNameInput): string {
  const langMatch = filename.match(/-([a-z]{2,3})-([a-z]{2,3})\./i);
  let langPair = "";
  if (langMatch) {
    langPair = `${langMatch[1]!.toUpperCase()}_${langMatch[2]!.toUpperCase()}`;
  } else {
    const tagLang = tagExtra || "";
    if (tagLang.match(/^[a-z]{2}-[a-z]{2}$/i)) {
      const [src, tgt] = tagLang.split("-");
      langPair = `${src!.toUpperCase()}_${tgt!.toUpperCase()}`;
    }
  }

  if (!langPair) {
    const roaMatch = filename.match(/-([a-z]{2,3})-([a-z]{2,3})-f16/i);
    if (roaMatch) {
      langPair = `${roaMatch[1]!.toUpperCase()}_${roaMatch[2]!.toUpperCase()}`;
    }
  }

  const nameParts = [langPair, quantization].filter((p) => p && p !== "");
  return `MARIAN_OPUS_${nameParts.map(cleanPart).join("_")}`;
}

function generateNmtBergamotName({ filename }: BaseNameInput): string {
  const langMatch = filename.match(/[.]([a-z]{2,4})[.]/i);
  let langPair = "";
  if (langMatch) {
    const code = langMatch[1]!;
    if (code.length === 4) {
      langPair = `${code.slice(0, 2).toUpperCase()}_${code.slice(2).toUpperCase()}`;
    } else {
      langPair = code.toUpperCase();
    }
  }

  let suffix = "";
  if (filename.startsWith("model.")) {
    suffix = "";
  } else if (filename.match(/^vocab\./)) {
    suffix = "_VOCAB";
  } else if (filename.match(/^srcvocab\./)) {
    suffix = "_SRCVOCAB";
  } else if (filename.match(/^trgvocab\./)) {
    suffix = "_TRGVOCAB";
  } else if (filename.startsWith("lex.")) {
    suffix = "_LEX";
  } else if (filename === "metadata.json") {
    suffix = "_METADATA";
  }

  return `BERGAMOT_${langPair}${suffix}`;
}

function generateLlmName({
  filename,
  tagType,
  tagName,
  modelName,
  quantization,
  params,
}: BaseNameInput): string {
  const type = tagType || "";
  const name = tagName || modelName || "";
  const isMMProj = filename.includes("mmproj");

  // Try to extract model family from filename to recover version info
  // that tags may omit (e.g., tag "qwen" but filename "Qwen3-1.7B-...")
  let familyName = name;
  if (params) {
    const parseFn = filename
      .replace(/^mmproj[-_]/i, "")
      .replace(/\.tensors\.txt$/, "")
      .replace(/\.\w+$/, "")
      .replace(/-\d{5}-of-\d{5}/, "");
    const paramsEsc = params.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const familyMatch = parseFn.match(
      new RegExp(`^(.+?)[-_]${paramsEsc}`, "i"),
    );
    if (familyMatch?.[1]) {
      const candidate = familyMatch[1];
      // Use filename family only if it extends the tag name
      // Strip common engine/format suffixes from tag before comparing
      const tagCore = name.replace(/[-_](ggml|cpp|onnx|llamacpp|metal)$/i, "");
      const cleanedCandidate = candidate.replace(/[-_.]/g, "").toLowerCase();
      const cleanedTagCore = tagCore.replace(/[-_.]/g, "").toLowerCase();
      if (
        cleanedCandidate.startsWith(cleanedTagCore) &&
        cleanedCandidate.length >= cleanedTagCore.length
      ) {
        familyName = candidate;
      }
    }
  }

  const nameParts = [familyName, params, type, quantization].filter(
    (p) => p && p !== "",
  );
  let exportName = nameParts.map(cleanPart).join("_");

  if (isMMProj) {
    exportName = "MMPROJ_" + exportName;
  }

  return exportName;
}

function generateEmbeddingsName({
  tagName,
  modelName,
  params,
  quantization,
}: BaseNameInput): string {
  const name = tagName || modelName || "";
  const nameParts = [name, params, quantization].filter((p) => p && p !== "");
  return nameParts.map(cleanPart).join("_");
}

function generateTtsName({
  filename,
  tagName,
  modelName,
  tagExtra,
  tagType,
  quantization,
}: BaseNameInput): string {
  const name = tagName || modelName || "";
  const language = tagExtra || "";
  const type = tagType || "";
  const nameParts = [name, language, type, quantization].filter(
    (p) => p && p !== "",
  );
  let exportName = `TTS_${nameParts.map(cleanPart).join("_")}`;
  if (filename.endsWith(".onnx.json") || filename.includes("config.json")) {
    exportName = exportName + "_CONFIG";
  }
  if (filename.endsWith(".onnx_data")) {
    exportName = exportName + "_DATA";
  }
  return exportName;
}

function generateOcrName({
  filename,
  tagName,
  modelName,
  tagExtra,
}: BaseNameInput): string {
  const name = tagName || modelName || "";
  const language = tagExtra || "";
  let fileType = "";
  if (filename.includes("detector")) {
    fileType = "DETECTOR";
  } else if (filename.includes("recognizer")) {
    fileType = "RECOGNIZER";
  }
  const nameParts = [name, language, fileType].filter((p) => p && p !== "");
  return `OCR_${nameParts.map(cleanPart).join("_")}`;
}
