// @ts-expect-error brittle has no type declarations
import test from "brittle";
import {
  processRegistryModel,
  toHexString,
  extractModelName,
} from "@/models/update-models/processing";
import { generateExportName } from "@/models/update-models/naming";
import { groupShardedModels } from "@/models/update-models/shards";
import { generateModelsFileContent } from "@/models/update-models/codegen";
import type { ProcessedModel } from "@/models/update-models/types";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

// Simulates a QVACModelEntry from the registry.  The real type comes from
// @qvac/registry-client (native module) so we re-declare a
// compatible shape to avoid pulling in NAPI at test time.
interface TestBlobBinding {
  coreKey: Buffer;
  blockOffset: number;
  blockLength: number;
  byteOffset: number;
  byteLength: number;
  sha256?: string; // runtime-only field the client sometimes attaches here
}

interface TestModelEntry {
  path: string;
  source: string;
  engine: string;
  license: string;
  name: string;
  sizeBytes: number;
  sha256: string;
  quantization?: string;
  params?: string;
  description?: string;
  notes?: string;
  tags?: string[];
  blobBinding: TestBlobBinding;
}

// Processes a test entry through the full pipeline and also generates the
// export name, returning both the ProcessedModel and the final name.
function processAndName(entry: TestModelEntry): {
  model: ProcessedModel;
  exportName: string;
} {
  // processRegistryModel expects QVACModelEntry — our TestModelEntry is
  // structurally compatible so we cast through `any`.
  const model = processRegistryModel(entry as any);
  if (!model)
    throw new Error(`processRegistryModel returned null for ${entry.path}`);

  const exportName = generateExportName({
    path: model.registryPath,
    engine: model.engine,
    name: model.modelName,
    quantization: model.quantization,
    params: model.params,
    tags: model.tags,
    usedNames: new Set<string>(),
  });

  return { model, exportName };
}

// ---------------------------------------------------------------------------
// toHexString
// ---------------------------------------------------------------------------

test("toHexString: converts Buffer to hex", (t: any) => {
  const buf = Buffer.from([0x34, 0xb0, 0xed, 0x5c, 0xad]);
  t.is(toHexString(buf), "34b0ed5cad");
});

test("toHexString: passes through a hex string unchanged", (t: any) => {
  t.is(toHexString("abcdef0123456789"), "abcdef0123456789");
});

test("toHexString: converts {data} object to hex", (t: any) => {
  t.is(toHexString({ data: [0xff, 0x00, 0xab] }), "ff00ab");
});

test("toHexString: returns empty string for undefined", (t: any) => {
  t.is(toHexString(undefined), "");
});

// ---------------------------------------------------------------------------
// extractModelName
// ---------------------------------------------------------------------------

test("extractModelName: extracts second path segment", (t: any) => {
  t.is(
    extractModelName(
      "ChristianAzinn/gte-large-gguf/blob/abc123/gte-large_fp16.gguf",
    ),
    "gte-large-gguf",
  );
});

test("extractModelName: extracts from s3-style path", (t: any) => {
  t.is(
    extractModelName(
      "qvac_models_compiled/ggml/Qwen3-4B/2025-06-27/Qwen3-4B-Q4_K_M.gguf",
    ),
    "ggml",
  );
});

// ---------------------------------------------------------------------------
// Embeddings: GTE-Large FP16
// ---------------------------------------------------------------------------

test("embeddings: GTE-Large FP16 — full field mapping", (t: any) => {
  const coreKey = Buffer.from(
    "34b0ed5cad561852a8a42288eb9b24a9d7859ab633a184ef0f433bf3bf19045e",
    "hex",
  );

  const { model, exportName } = processAndName({
    path: "ChristianAzinn/gte-large-gguf/blob/f9fa5479908e72c2a8b9d6ba112911cd1e51be53/gte-large_fp16.gguf",
    source: "hf",
    engine: "@qvac/embed-llamacpp",
    license: "MIT",
    name: "",
    sizeBytes: 669603712,
    sha256: "939f1fb3fcc70f2a250a7e7ad7c2fbdc1397d46f9a8055d053e451829c5293fb",
    quantization: "fp16",
    params: "",
    tags: ["embedding", "bert", "gte-large-gguf"],
    blobBinding: {
      coreKey,
      blockOffset: 278131,
      blockLength: 10218,
      byteOffset: 18226816682,
      byteLength: 669603712,
    },
  });

  // Field mapping
  t.is(
    model.registryPath,
    "ChristianAzinn/gte-large-gguf/blob/f9fa5479908e72c2a8b9d6ba112911cd1e51be53/gte-large_fp16.gguf",
  );
  t.is(model.registrySource, "hf");
  t.is(
    model.blobCoreKey,
    "34b0ed5cad561852a8a42288eb9b24a9d7859ab633a184ef0f433bf3bf19045e",
  );
  t.is(model.blobBlockOffset, 278131);
  t.is(model.blobBlockLength, 10218);
  t.is(model.blobByteOffset, 18226816682);
  t.is(model.modelId, "gte-large_fp16.gguf");
  t.is(model.addon, "embeddings");
  t.is(model.expectedSize, 669603712);
  t.is(
    model.sha256Checksum,
    "939f1fb3fcc70f2a250a7e7ad7c2fbdc1397d46f9a8055d053e451829c5293fb",
  );
  t.is(model.engine, "llamacpp-embedding");
  t.is(model.quantization, "fp16");
  t.is(model.params, "");
  t.alike(model.tags, ["embedding", "bert", "gte-large-gguf"]);
  t.is(model.modelName, "gte-large-gguf");
  t.absent(model.isShardPart);
  t.absent(model.shardInfo);

  // Naming
  t.is(exportName, "GTE_LARGE_FP16");
});

// ---------------------------------------------------------------------------
// Whisper: tiny (no quant, legacy engine)
// ---------------------------------------------------------------------------

test("whisper: tiny — full field mapping with legacy engine", (t: any) => {
  const coreKey = Buffer.from("aa".repeat(32), "hex");

  const { model, exportName } = processAndName({
    path: "ggerganov/whisper.cpp/resolve/5359861c739e955e79d9a303bcbc70fb988958b1/ggml-tiny.bin",
    source: "hf",
    engine: "@qvac/transcription-whispercpp",
    license: "MIT",
    name: "",
    sizeBytes: 78161756,
    sha256: "be07e048e1e599ad46341c8d2a135645097a538221678b7acdd1b1919c6e1b21",
    quantization: "",
    params: "",
    tags: ["transcription", "tiny-silero", "whisper"],
    blobBinding: {
      coreKey,
      blockOffset: 1000,
      blockLength: 50,
      byteOffset: 5000000,
      byteLength: 78161756,
    },
  });

  t.is(
    model.registryPath,
    "ggerganov/whisper.cpp/resolve/5359861c739e955e79d9a303bcbc70fb988958b1/ggml-tiny.bin",
  );
  t.is(model.registrySource, "hf");
  t.is(model.blobCoreKey, "aa".repeat(32));
  t.is(model.blobBlockOffset, 1000);
  t.is(model.blobBlockLength, 50);
  t.is(model.blobByteOffset, 5000000);
  t.is(model.expectedSize, 78161756);
  t.is(
    model.sha256Checksum,
    "be07e048e1e599ad46341c8d2a135645097a538221678b7acdd1b1919c6e1b21",
  );
  t.is(
    model.engine,
    "whispercpp-transcription",
    "legacy engine resolved to canonical",
  );
  t.is(model.addon, "whisper");
  t.is(model.modelId, "ggml-tiny.bin");
  t.is(model.quantization, "");
  t.is(model.params, "");
  t.alike(model.tags, ["transcription", "tiny-silero", "whisper"]);

  t.is(exportName, "WHISPER_TINY");
});

// ---------------------------------------------------------------------------
// Whisper: English-only .en model
// ---------------------------------------------------------------------------

test("whisper: English-only small.en q8_0 — full field mapping", (t: any) => {
  const coreKey = Buffer.from("bb".repeat(32), "hex");

  const { model, exportName } = processAndName({
    path: "ggerganov/whisper.cpp/resolve/5359861c739e955e79d9a303bcbc70fb988958b1/ggml-small.en-q8_0.bin",
    source: "hf",
    engine: "@qvac/transcription-whispercpp",
    license: "MIT",
    name: "",
    sizeBytes: 487662476,
    sha256: "aabb1122334455667788aabb1122334455667788aabb1122334455667788aabb",
    quantization: "q8",
    params: "",
    tags: ["transcription", "small", "whisper", "silero"],
    blobBinding: {
      coreKey,
      blockOffset: 2000,
      blockLength: 100,
      byteOffset: 10000000,
      byteLength: 487662476,
    },
  });

  t.is(model.engine, "whispercpp-transcription");
  t.is(model.addon, "whisper");
  t.is(model.modelId, "ggml-small.en-q8_0.bin");
  t.is(
    model.sha256Checksum,
    "aabb1122334455667788aabb1122334455667788aabb1122334455667788aabb",
  );
  t.is(model.expectedSize, 487662476);
  t.is(model.blobCoreKey, "bb".repeat(32));

  t.is(exportName, "WHISPER_EN_SMALL_Q8_0");
});

// ---------------------------------------------------------------------------
// Whisper: large-v3-turbo
// ---------------------------------------------------------------------------

test("whisper: large-v3-turbo — full field mapping", (t: any) => {
  const coreKey = Buffer.from("cc".repeat(32), "hex");

  const { model, exportName } = processAndName({
    path: "ggerganov/whisper.cpp/resolve/5359861c739e955e79d9a303bcbc70fb988958b1/ggml-large-v3-turbo.bin",
    source: "hf",
    engine: "@qvac/transcription-whispercpp",
    license: "MIT",
    name: "",
    sizeBytes: 1626244956,
    sha256: "ccdd1122334455667788ccdd1122334455667788ccdd1122334455667788ccdd",
    quantization: "",
    params: "",
    tags: ["transcription", "large", "whisper", "silero"],
    blobBinding: {
      coreKey,
      blockOffset: 3000,
      blockLength: 200,
      byteOffset: 20000000,
      byteLength: 1626244956,
    },
  });

  t.is(model.addon, "whisper");
  t.is(model.engine, "whispercpp-transcription");
  t.is(model.expectedSize, 1626244956);
  t.is(
    model.sha256Checksum,
    "ccdd1122334455667788ccdd1122334455667788ccdd1122334455667788ccdd",
  );

  t.is(exportName, "WHISPER_LARGE_V3_TURBO");
});

// ---------------------------------------------------------------------------
// VAD Silero (detected by filename despite whisper engine)
// ---------------------------------------------------------------------------

test("vad: silero model — engine whisper but filename silero overrides to VAD", (t: any) => {
  const coreKey = Buffer.from("dd".repeat(32), "hex");

  const { model, exportName } = processAndName({
    path: "ggml-org/whisper-vad/resolve/9ffd54a1e1ee413ddf265af9913beaf518d1639b/ggml-silero-v5.1.2.bin",
    source: "hf",
    engine: "@qvac/transcription-whispercpp",
    license: "MIT",
    name: "",
    sizeBytes: 6400000,
    sha256: "ddee1122334455667788ddee1122334455667788ddee1122334455667788ddee",
    quantization: "",
    params: "",
    description: "VAD model for Whisper",
    tags: ["transcription", "tiny-silero", "whisper"],
    blobBinding: {
      coreKey,
      blockOffset: 4000,
      blockLength: 10,
      byteOffset: 30000000,
      byteLength: 6400000,
    },
  });

  // Engine resolves to whisper canonical, but addon should still be whisper
  // (the naming strategy handles the silero override at name generation time)
  t.is(model.engine, "whispercpp-transcription");
  t.is(model.addon, "whisper");
  t.is(model.modelId, "ggml-silero-v5.1.2.bin");
  t.is(
    model.sha256Checksum,
    "ddee1122334455667788ddee1122334455667788ddee1122334455667788ddee",
  );
  t.is(model.blobCoreKey, "dd".repeat(32));
  t.is(model.expectedSize, 6400000);

  // Naming detects silero from filename → VAD_SILERO prefix
  t.is(exportName, "VAD_SILERO_5_1_2");
});

// ---------------------------------------------------------------------------
// LLM: Qwen3-4B (legacy engine, s3 source)
// ---------------------------------------------------------------------------

test("llm: Qwen3-4B — full field mapping with legacy engine + s3 source", (t: any) => {
  const coreKey = Buffer.from("ee".repeat(32), "hex");

  const { model, exportName } = processAndName({
    path: "qvac_models_compiled/ggml/Qwen3-4B/2025-06-27/Qwen3-4B-Q4_K_M.gguf",
    source: "s3",
    engine: "@qvac/llm-llamacpp",
    license: "Apache-2.0",
    name: "",
    sizeBytes: 2700000000,
    sha256: "eeff1122334455667788eeff1122334455667788eeff1122334455667788eeff",
    quantization: "q4",
    params: "4B",
    description: "Multimodal 4B model, good for tool calls",
    tags: ["generation", "instruct", "qwen3"],
    blobBinding: {
      coreKey,
      blockOffset: 5000,
      blockLength: 500,
      byteOffset: 40000000,
      byteLength: 2700000000,
    },
  });

  t.is(
    model.registryPath,
    "qvac_models_compiled/ggml/Qwen3-4B/2025-06-27/Qwen3-4B-Q4_K_M.gguf",
  );
  t.is(model.registrySource, "s3");
  t.is(
    model.engine,
    "llamacpp-completion",
    "legacy @qvac/llm-llamacpp resolved",
  );
  t.is(model.addon, "llm");
  t.is(model.blobCoreKey, "ee".repeat(32));
  t.is(model.blobBlockOffset, 5000);
  t.is(model.blobBlockLength, 500);
  t.is(model.blobByteOffset, 40000000);
  t.is(model.expectedSize, 2700000000);
  t.is(
    model.sha256Checksum,
    "eeff1122334455667788eeff1122334455667788eeff1122334455667788eeff",
  );
  t.is(model.modelId, "Qwen3-4B-Q4_K_M.gguf");
  t.is(model.quantization, "q4");
  t.is(model.params, "4B");
  t.alike(model.tags, ["generation", "instruct", "qwen3"]);

  t.is(exportName, "QWEN3_4B_INST_Q4");
});

// ---------------------------------------------------------------------------
// LLM: Llama 3.2 (tag strips engine suffix for version recovery)
// ---------------------------------------------------------------------------

test("llm: Llama-3.2-1B — tag 'llama-ggml' version recovery from filename", (t: any) => {
  const coreKey = Buffer.from("ff".repeat(32), "hex");

  const { model, exportName } = processAndName({
    path: "meta-llama/Llama-3.2-1B-Instruct-GGUF/blob/abc123/Llama-3.2-1B-Instruct-Q4_0.gguf",
    source: "hf",
    engine: "@qvac/llm-llamacpp",
    license: "Meta-Llama-3.2",
    name: "",
    sizeBytes: 850000000,
    sha256: "1122334455667788aabb1122334455667788aabb1122334455667788aabb1122",
    quantization: "q4_0",
    params: "1B",
    tags: ["generation", "instruct", "llama-ggml"],
    blobBinding: {
      coreKey,
      blockOffset: 6000,
      blockLength: 300,
      byteOffset: 50000000,
      byteLength: 850000000,
    },
  });

  t.is(model.engine, "llamacpp-completion");
  t.is(model.addon, "llm");
  t.is(model.modelId, "Llama-3.2-1B-Instruct-Q4_0.gguf");
  t.is(
    model.sha256Checksum,
    "1122334455667788aabb1122334455667788aabb1122334455667788aabb1122",
  );

  // Tag "llama-ggml" → strip "-ggml" → "llama" → filename "Llama-3.2" extends it
  t.is(exportName, "LLAMA_3_2_1B_INST_Q4_0");
});

// ---------------------------------------------------------------------------
// LLM: mmproj vision adapter (Qwen2.5-Omni)
// ---------------------------------------------------------------------------

test("llm: mmproj Qwen2.5-Omni — MMPROJ prefix + multimodal tag", (t: any) => {
  const coreKey = Buffer.from("ab".repeat(32), "hex");

  const { model, exportName } = processAndName({
    path: "ggml-org/Qwen2.5-Omni-3B-GGUF/blob/75f1b73b657a50f5092502799457ccb4a4a1f9df/mmproj-Qwen2.5-Omni-3B-Q8_0.gguf",
    source: "hf",
    engine: "@qvac/llm-llamacpp",
    license: "Qwen",
    name: "",
    sizeBytes: 1500000000,
    sha256: "aabbccdd11223344aabbccdd11223344aabbccdd11223344aabbccdd11223344",
    quantization: "",
    params: "3B",
    tags: ["generation", "multimodal", "qwen2.5-omni"],
    blobBinding: {
      coreKey,
      blockOffset: 7000,
      blockLength: 400,
      byteOffset: 60000000,
      byteLength: 1500000000,
    },
  });

  t.is(model.engine, "llamacpp-completion");
  t.is(model.addon, "llm");
  t.is(model.modelId, "mmproj-Qwen2.5-Omni-3B-Q8_0.gguf");

  t.ok(
    exportName.startsWith("MMPROJ_"),
    `expected MMPROJ_ prefix, got: ${exportName}`,
  );
  t.ok(
    exportName.includes("QWEN2_5_OMNI"),
    `expected QWEN2_5_OMNI, got: ${exportName}`,
  );
});

// ---------------------------------------------------------------------------
// LLM: sharded model (medgemma shard 1/5)
// ---------------------------------------------------------------------------

test("llm: medgemma sharded — shard detection + _SHARD suffix", (t: any) => {
  const coreKey = Buffer.from("cd".repeat(32), "hex");

  const { model, exportName } = processAndName({
    path: "qvac_models_compiled/ggml/medgemma-4b-it-Q4/2025-08-21/medgemma-4b-it-Q4_1-00001-of-00005.gguf",
    source: "s3",
    engine: "@qvac/llm-llamacpp",
    license: "Apache-2.0",
    name: "",
    sizeBytes: 600000000,
    sha256: "cdcdcdcd11223344cdcdcdcd11223344cdcdcdcd11223344cdcdcdcd11223344",
    quantization: "q4_1",
    params: "4B",
    tags: ["generation", "it", "medgemma", "shard"],
    notes: "shard 1/5",
    blobBinding: {
      coreKey,
      blockOffset: 8000,
      blockLength: 200,
      byteOffset: 70000000,
      byteLength: 600000000,
    },
  });

  t.is(model.engine, "llamacpp-completion");
  t.is(model.addon, "llm");
  t.is(model.modelId, "medgemma-4b-it-Q4_1-00001-of-00005.gguf");
  t.is(
    model.sha256Checksum,
    "cdcdcdcd11223344cdcdcdcd11223344cdcdcdcd11223344cdcdcdcd11223344",
  );

  // Shard detection
  t.ok(model.isShardPart, "should be detected as shard part");
  t.ok(model.shardInfo, "should have shardInfo");
  t.is(model.shardInfo!.isSharded, true);
  t.is(model.shardInfo!.currentShard, 1);
  t.is(model.shardInfo!.totalShards, 5);
  t.is(model.shardInfo!.baseFilename, "medgemma-4b-it-Q4_1");

  // Naming includes _SHARD, not the shard number
  t.ok(
    exportName.endsWith("_SHARD"),
    `expected _SHARD suffix, got: ${exportName}`,
  );
  t.ok(
    !exportName.includes("00001"),
    `should not contain shard number, got: ${exportName}`,
  );
});

// ---------------------------------------------------------------------------
// LLM: tensors.txt metadata file
// ---------------------------------------------------------------------------

test("llm: medgemma tensors.txt — _TENSORS suffix", (t: any) => {
  const coreKey = Buffer.from("de".repeat(32), "hex");

  const { model, exportName } = processAndName({
    path: "qvac_models_compiled/ggml/medgemma-4b-it-Q4/2025-08-21/medgemma-4b-it-Q4_1.tensors.txt",
    source: "s3",
    engine: "@qvac/llm-llamacpp",
    license: "Apache-2.0",
    name: "",
    sizeBytes: 12345,
    sha256: "dededede11223344dededede11223344dededede11223344dededede11223344",
    quantization: "q4_1",
    params: "4B",
    description:
      "Required for Llamacpp to create the model layers before the weights are loaded",
    tags: ["generation", "it", "medgemma", "shard"],
    notes: "tensors config",
    blobBinding: {
      coreKey,
      blockOffset: 9000,
      blockLength: 1,
      byteOffset: 80000000,
      byteLength: 12345,
    },
  });

  t.is(model.engine, "llamacpp-completion");
  t.is(model.addon, "llm");
  t.is(model.modelId, "medgemma-4b-it-Q4_1.tensors.txt");
  t.is(model.expectedSize, 12345);

  // Naming adds _TENSORS suffix
  t.ok(
    exportName.endsWith("_TENSORS"),
    `expected _TENSORS suffix, got: ${exportName}`,
  );
  t.ok(
    exportName.includes("MEDGEMMA"),
    `expected MEDGEMMA, got: ${exportName}`,
  );
});

// ---------------------------------------------------------------------------
// LLM override: SmolVLM2 with translation engine → overridden to LLM
// ---------------------------------------------------------------------------

test("llm override: SmolVLM2 with translation engine + multimodal tag → treated as LLM", (t: any) => {
  const coreKey = Buffer.from("ef".repeat(32), "hex");

  const { model, exportName } = processAndName({
    path: "ggml-org/SmolVLM2-500M-Video-Instruct-GGUF/resolve/ccd7aae53bcb1997355c2f094959e72b3642ce17/SmolVLM2-500M-Video-Instruct-f16.gguf",
    source: "hf",
    engine: "@qvac/translation-llamacpp",
    license: "Apache-2.0",
    name: "",
    sizeBytes: 1100000000,
    sha256: "efefefef11223344efefefef11223344efefefef11223344efefefef11223344",
    quantization: "f16",
    params: "500M",
    tags: ["generation", "multimodal", "smolvlm2", "video-instruct"],
    blobBinding: {
      coreKey,
      blockOffset: 10000,
      blockLength: 300,
      byteOffset: 90000000,
      byteLength: 1100000000,
    },
  });

  // Engine resolves to nmt canonical, but addon on ProcessedModel stays "nmt"
  // (the override happens in the naming step)
  t.is(model.engine, "nmtcpp-translation");
  t.is(model.addon, "nmt");
  t.is(
    model.sha256Checksum,
    "efefefef11223344efefefef11223344efefefef11223344efefefef11223344",
  );

  // Naming overrides to LLM path → no NMT_ prefix
  t.ok(
    !exportName.startsWith("NMT_"),
    `should not start with NMT_, got: ${exportName}`,
  );
  t.ok(
    exportName.includes("SMOLVLM2"),
    `should include SMOLVLM2, got: ${exportName}`,
  );
});

// ---------------------------------------------------------------------------
// NMT: Salamandra (legacy @qvac/translation-llamacpp engine)
// ---------------------------------------------------------------------------

test("nmt: Salamandra 2B q8 — legacy translation-llamacpp engine", (t: any) => {
  const coreKey = Buffer.from("11".repeat(32), "hex");

  const { model, exportName } = processAndName({
    path: "BSC-LT/salamandraTA-2B-instruct-GGUF/blob/60046856fcac87c47fb0c706e994e70f01eda62b/salamandrata_2b_inst_q8.gguf",
    source: "hf",
    engine: "@qvac/translation-llamacpp",
    license: "Apache-2.0",
    name: "",
    sizeBytes: 2400000000,
    sha256: "11111111223344551111111122334455111111112233445511111111aabbccdd",
    quantization: "q8",
    params: "2B",
    tags: ["generation", "instruct", "salamandrata"],
    blobBinding: {
      coreKey,
      blockOffset: 11000,
      blockLength: 500,
      byteOffset: 100000000,
      byteLength: 2400000000,
    },
  });

  // translation-llamacpp → nmtcpp-translation
  t.is(model.engine, "nmtcpp-translation");
  t.is(model.addon, "nmt");
  t.is(model.quantization, "q8");
  t.is(model.params, "2B");
  t.is(model.modelId, "salamandrata_2b_inst_q8.gguf");

  t.is(exportName, "SALAMANDRATA_2B_INST_Q8");
});

// ---------------------------------------------------------------------------
// NMT: Indictrans en-indic-1B
// ---------------------------------------------------------------------------

test("nmt: Indictrans en-indic 1B q0f16 — full field mapping", (t: any) => {
  const coreKey = Buffer.from("22".repeat(32), "hex");

  const { model, exportName } = processAndName({
    path: "qvac_models_compiled/ggml/indictrans2/q0f16/ggml-indictrans2-en-indic-1B/2025-09-09/ggml-indictrans2-en-indic-1B-q0f16.bin",
    source: "s3",
    engine: "@qvac/translation-nmtcpp",
    license: "MIT",
    name: "",
    sizeBytes: 480000000,
    sha256: "22222222223344552222222222334455222222222233445522222222aabbccdd",
    quantization: "q0f16",
    params: "1B",
    tags: ["translation", "full", "ggml-indictrans", "en-hi"],
    blobBinding: {
      coreKey,
      blockOffset: 12000,
      blockLength: 200,
      byteOffset: 110000000,
      byteLength: 480000000,
    },
  });

  t.is(model.engine, "nmtcpp-translation");
  t.is(model.addon, "nmt");
  t.is(model.registrySource, "s3");
  t.is(
    model.sha256Checksum,
    "22222222223344552222222222334455222222222233445522222222aabbccdd",
  );

  t.is(exportName, "MARIAN_EN_HI_INDIC_1B_Q0F16");
});

// ---------------------------------------------------------------------------
// NMT: Opus en-ru
// ---------------------------------------------------------------------------

test("nmt: Opus en-ru q0f16 — full field mapping", (t: any) => {
  const coreKey = Buffer.from("33".repeat(32), "hex");

  const { model, exportName } = processAndName({
    path: "qvac_models_compiled/ggml/marian/q0f16/ggml-opus-en-ru/2025-11-09/ggml-opus-en-ru.bin",
    source: "s3",
    engine: "@qvac/translation-nmtcpp",
    license: "Apache-2.0",
    name: "",
    sizeBytes: 120000000,
    sha256: "33333333223344553333333322334455333333332233445533333333aabbccdd",
    quantization: "q0f16",
    params: "",
    tags: ["translation", "opus", "marian", "en-ru"],
    blobBinding: {
      coreKey,
      blockOffset: 13000,
      blockLength: 100,
      byteOffset: 120000000,
      byteLength: 120000000,
    },
  });

  t.is(model.engine, "nmtcpp-translation");
  t.is(model.addon, "nmt");
  t.is(model.blobCoreKey, "33".repeat(32));
  t.is(model.blobBlockOffset, 13000);
  t.is(model.expectedSize, 120000000);

  t.is(exportName, "MARIAN_OPUS_EN_RU_Q0F16");
});

// ---------------------------------------------------------------------------
// NMT: Bergamot model file
// ---------------------------------------------------------------------------

test("nmt: Bergamot ar-en model file — full field mapping", (t: any) => {
  const coreKey = Buffer.from("44".repeat(32), "hex");

  const { model, exportName } = processAndName({
    path: "qvac_models_compiled/bergamot/bergamot-aren/model.aren.intgemm.alphas.bin",
    source: "s3",
    engine: "@qvac/translation-nmtcpp",
    license: "MIT",
    name: "",
    sizeBytes: 17000000,
    sha256: "44444444223344554444444422334455444444442233445544444444aabbccdd",
    quantization: "",
    params: "",
    description: "Bergamot NMT model ar-en",
    tags: ["translation", "nmt", "bergamot", "aren"],
    blobBinding: {
      coreKey,
      blockOffset: 14000,
      blockLength: 50,
      byteOffset: 130000000,
      byteLength: 17000000,
    },
  });

  t.is(model.engine, "nmtcpp-translation");
  t.is(model.addon, "nmt");
  t.is(model.modelId, "model.aren.intgemm.alphas.bin");
  t.is(
    model.sha256Checksum,
    "44444444223344554444444422334455444444442233445544444444aabbccdd",
  );

  t.is(exportName, "BERGAMOT_AR_EN");
});

// ---------------------------------------------------------------------------
// NMT: Bergamot vocab file
// ---------------------------------------------------------------------------

test("nmt: Bergamot ar-en vocab file — _VOCAB suffix", (t: any) => {
  const coreKey = Buffer.from("55".repeat(32), "hex");

  const { model, exportName } = processAndName({
    path: "qvac_models_compiled/bergamot/bergamot-aren/vocab.aren.spm",
    source: "s3",
    engine: "@qvac/translation-nmtcpp",
    license: "MIT",
    name: "",
    sizeBytes: 500000,
    sha256: "55555555223344555555555522334455555555552233445555555555aabbccdd",
    quantization: "",
    params: "",
    description: "Bergamot vocabulary ar-en",
    tags: ["translation", "nmt", "bergamot", "aren"],
    blobBinding: {
      coreKey,
      blockOffset: 15000,
      blockLength: 10,
      byteOffset: 140000000,
      byteLength: 500000,
    },
  });

  t.is(model.addon, "nmt");
  t.is(model.modelId, "vocab.aren.spm");

  t.is(exportName, "BERGAMOT_AR_EN_VOCAB");
});

// ---------------------------------------------------------------------------
// NMT: Bergamot lex file
// ---------------------------------------------------------------------------

test("nmt: Bergamot ar-en lex file — _LEX suffix", (t: any) => {
  const coreKey = Buffer.from("66".repeat(32), "hex");

  const { model, exportName } = processAndName({
    path: "qvac_models_compiled/bergamot/bergamot-aren/lex.50.50.aren.s2t.bin",
    source: "s3",
    engine: "@qvac/translation-nmtcpp",
    license: "MIT",
    name: "",
    sizeBytes: 3000000,
    sha256: "66666666223344556666666622334455666666662233445566666666aabbccdd",
    quantization: "",
    params: "",
    description: "Bergamot lexical shortlist ar-en",
    tags: ["translation", "nmt", "bergamot", "aren"],
    blobBinding: {
      coreKey,
      blockOffset: 16000,
      blockLength: 20,
      byteOffset: 150000000,
      byteLength: 3000000,
    },
  });

  t.is(model.addon, "nmt");
  t.is(model.modelId, "lex.50.50.aren.s2t.bin");

  t.is(exportName, "BERGAMOT_AR_EN_LEX");
});

// ---------------------------------------------------------------------------
// TTS: Piper Norman medium
// ---------------------------------------------------------------------------

test("tts: Piper Norman medium — full field mapping", (t: any) => {
  const coreKey = Buffer.from("77".repeat(32), "hex");

  const { model, exportName } = processAndName({
    path: "rhasspy/piper-voices/resolve/0622afc867cf0388684853ecdf59a498b489949d/en/en_US/norman/medium/en_US-norman-medium.onnx",
    source: "hf",
    engine: "@qvac/tts",
    license: "MIT",
    name: "",
    sizeBytes: 60000000,
    sha256: "77777777223344557777777722334455777777772233445577777777aabbccdd",
    quantization: "fp32",
    params: "20M",
    description: "Norman voice (medium quality)",
    tags: ["tts", "onnx-medium", "piper-norman", "en_us"],
    blobBinding: {
      coreKey,
      blockOffset: 17000,
      blockLength: 150,
      byteOffset: 160000000,
      byteLength: 60000000,
    },
  });

  t.is(model.engine, "onnx-tts", "legacy @qvac/tts resolved to onnx-tts");
  t.is(model.addon, "tts");
  t.is(model.modelId, "en_US-norman-medium.onnx");
  t.is(
    model.sha256Checksum,
    "77777777223344557777777722334455777777772233445577777777aabbccdd",
  );
  t.is(model.expectedSize, 60000000);
  t.is(model.blobCoreKey, "77".repeat(32));
  t.is(model.blobBlockOffset, 17000);
  t.is(model.blobBlockLength, 150);
  t.is(model.blobByteOffset, 160000000);

  t.is(exportName, "TTS_PIPER_NORMAN_EN_US_ONNX_MEDIUM_FP32");
});

// ---------------------------------------------------------------------------
// TTS: Piper config file (.onnx.json)
// ---------------------------------------------------------------------------

test("tts: Piper config file — _CONFIG suffix", (t: any) => {
  const coreKey = Buffer.from("88".repeat(32), "hex");

  const { model, exportName } = processAndName({
    path: "rhasspy/piper-voices/resolve/0622afc/en/en_US/norman/medium/en_US-norman-medium.onnx.json",
    source: "hf",
    engine: "@qvac/tts",
    license: "MIT",
    name: "",
    sizeBytes: 2000,
    sha256: "88888888223344558888888822334455888888882233445588888888aabbccdd",
    quantization: "fp32",
    params: "20M",
    tags: ["tts", "onnx-medium", "piper-norman", "en_us"],
    blobBinding: {
      coreKey,
      blockOffset: 18000,
      blockLength: 1,
      byteOffset: 170000000,
      byteLength: 2000,
    },
  });

  t.is(model.addon, "tts");
  t.is(model.modelId, "en_US-norman-medium.onnx.json");
  t.is(model.expectedSize, 2000);

  t.ok(
    exportName.endsWith("_CONFIG"),
    `expected _CONFIG suffix, got: ${exportName}`,
  );
  t.ok(
    exportName.includes("TTS_PIPER_NORMAN"),
    `expected TTS_PIPER_NORMAN, got: ${exportName}`,
  );
});

// ---------------------------------------------------------------------------
// OCR: Recognizer English
// ---------------------------------------------------------------------------

test("ocr: recognizer english — full field mapping", (t: any) => {
  const coreKey = Buffer.from("99".repeat(32), "hex");

  const { model, exportName } = processAndName({
    path: "qvac_models_compiled/ocr/2025-04-25/recognizer_english.onnx",
    source: "s3",
    engine: "@qvac/ocr-onnx",
    license: "Apache-2.0",
    name: "",
    sizeBytes: 25000000,
    sha256: "99999999223344559999999922334455999999992233445599999999aabbccdd",
    quantization: "",
    params: "",
    description: "Text recognizer",
    tags: ["ocr", "recognizer", "craft", "english"],
    blobBinding: {
      coreKey,
      blockOffset: 19000,
      blockLength: 80,
      byteOffset: 180000000,
      byteLength: 25000000,
    },
  });

  t.is(model.engine, "onnx-ocr", "legacy @qvac/ocr-onnx resolved to onnx-ocr");
  t.is(model.addon, "ocr");
  t.is(model.modelId, "recognizer_english.onnx");
  t.is(
    model.sha256Checksum,
    "99999999223344559999999922334455999999992233445599999999aabbccdd",
  );
  t.is(model.blobCoreKey, "99".repeat(32));
  t.is(model.expectedSize, 25000000);

  t.is(exportName, "OCR_CRAFT_ENGLISH_RECOGNIZER");
});

// ---------------------------------------------------------------------------
// OCR: Detector CRAFT
// ---------------------------------------------------------------------------

test("ocr: detector craft — full field mapping", (t: any) => {
  const coreKey = Buffer.from("a1".repeat(32), "hex");

  const { model, exportName } = processAndName({
    path: "qvac_models_compiled/ocr/2025-04-25/detector_craft.onnx",
    source: "s3",
    engine: "@qvac/ocr-onnx",
    license: "Apache-2.0",
    name: "",
    sizeBytes: 45000000,
    sha256: "a1a1a1a1223344a1a1a1a1a122334455a1a1a1a12233a1a1a1a1a1a1aabbccdd",
    quantization: "",
    params: "",
    description: "CRAFT text detector",
    tags: ["ocr", "recognizer", "craft", "english"],
    blobBinding: {
      coreKey,
      blockOffset: 20000,
      blockLength: 120,
      byteOffset: 190000000,
      byteLength: 45000000,
    },
  });

  t.is(model.addon, "ocr");
  t.is(model.modelId, "detector_craft.onnx");

  t.is(exportName, "OCR_CRAFT_ENGLISH_DETECTOR");
});

// ---------------------------------------------------------------------------
// sha256 fallback: sha256 on blobBinding (runtime field, not on model.sha256)
// ---------------------------------------------------------------------------

test("sha256 fallback: reads from blobBinding.sha256 when model.sha256 is empty", (t: any) => {
  const coreKey = Buffer.from("b2".repeat(32), "hex");

  const entry = {
    path: "test/model/blob/abc/test-model.gguf",
    source: "hf",
    engine: "llamacpp-completion",
    license: "MIT",
    name: "test",
    sizeBytes: 100,
    sha256: "", // empty on model
    quantization: "q4",
    params: "1B",
    tags: ["generation", "instruct", "test"],
    blobBinding: {
      coreKey,
      blockOffset: 1,
      blockLength: 1,
      byteOffset: 1,
      byteLength: 100,
      sha256:
        "fallback_hash_from_blob_binding_runtime_only_field_0000000000000000",
    },
  };

  const model = processRegistryModel(entry as any);
  t.ok(model, "should not return null");
  t.is(
    model!.sha256Checksum,
    "fallback_hash_from_blob_binding_runtime_only_field_0000000000000000",
    "should fall back to blobBinding.sha256",
  );
});

// ---------------------------------------------------------------------------
// Unknown engine → processRegistryModel returns null
// ---------------------------------------------------------------------------

test("unknown engine: processRegistryModel returns null", (t: any) => {
  const coreKey = Buffer.from("c3".repeat(32), "hex");

  const model = processRegistryModel({
    path: "test/unknown-engine.bin",
    source: "hf",
    engine: "totally-made-up-engine",
    license: "MIT",
    name: "",
    sizeBytes: 100,
    sha256: "abc",
    blobBinding: {
      coreKey,
      blockOffset: 0,
      blockLength: 0,
      byteOffset: 0,
      byteLength: 100,
    },
  } as any);

  t.is(model, null, "should return null for unrecognized engine");
});

// ---------------------------------------------------------------------------
// Missing optional fields (no quantization, no params, no tags)
// ---------------------------------------------------------------------------

test("missing optional fields: defaults to empty strings/arrays", (t: any) => {
  const coreKey = Buffer.from("d4".repeat(32), "hex");

  const { model } = processAndName({
    path: "ggerganov/whisper.cpp/resolve/abc/ggml-tiny.bin",
    source: "hf",
    engine: "whispercpp-transcription",
    license: "MIT",
    name: "",
    sizeBytes: 100,
    sha256: "d4d4d4d4d4d4d4d4d4d4d4d4d4d4d4d4d4d4d4d4d4d4d4d4d4d4d4d4d4d4d4d4",
    // no quantization, no params, no tags
    blobBinding: {
      coreKey,
      blockOffset: 0,
      blockLength: 0,
      byteOffset: 0,
      byteLength: 100,
    },
  });

  t.is(model.quantization, "");
  t.is(model.params, "");
  t.alike(model.tags, []);
});

// ---------------------------------------------------------------------------
// Collision resolution: full pipeline with two models
// ---------------------------------------------------------------------------

test("collision: two identical whisper tiny models get unique names", (t: any) => {
  const usedNames = new Set<string>();
  const coreKey = Buffer.from("e5".repeat(32), "hex");

  const entry1 = {
    path: "repo1/whisper.cpp/resolve/abc/ggml-tiny.bin",
    source: "hf",
    engine: "@qvac/transcription-whispercpp",
    license: "MIT",
    name: "",
    sizeBytes: 100,
    sha256: "aaaa",
    tags: ["transcription", "tiny-silero", "whisper"],
    blobBinding: {
      coreKey,
      blockOffset: 1,
      blockLength: 1,
      byteOffset: 1,
      byteLength: 100,
    },
  };

  const entry2 = {
    path: "repo2/whisper.cpp/resolve/def/ggml-tiny.bin",
    source: "hf",
    engine: "@qvac/transcription-whispercpp",
    license: "MIT",
    name: "",
    sizeBytes: 200,
    sha256: "bbbb",
    tags: ["transcription", "tiny-silero", "whisper"],
    blobBinding: {
      coreKey,
      blockOffset: 2,
      blockLength: 2,
      byteOffset: 2,
      byteLength: 200,
    },
  };

  const m1 = processRegistryModel(entry1 as any)!;
  const m2 = processRegistryModel(entry2 as any)!;

  const name1 = generateExportName({
    path: m1.registryPath,
    engine: m1.engine,
    name: m1.modelName,
    quantization: m1.quantization,
    params: m1.params,
    tags: m1.tags,
    usedNames,
  });

  const name2 = generateExportName({
    path: m2.registryPath,
    engine: m2.engine,
    name: m2.modelName,
    quantization: m2.quantization,
    params: m2.params,
    tags: m2.tags,
    usedNames,
  });

  t.is(name1, "WHISPER_TINY");
  t.is(name2, "WHISPER_TINY_1", "second gets sequential counter");
  t.not(name1, name2, "names must be unique");
});

// ---------------------------------------------------------------------------
// Whisper: language-specific (Japanese tiny f16)
// ---------------------------------------------------------------------------

test("whisper: Japanese tiny f16 — language-specific model", (t: any) => {
  const coreKey = Buffer.from("f6".repeat(32), "hex");

  const { model, exportName } = processAndName({
    path: "whisper-japanese/hf/ja-tiny-ggml-model-f16.bin",
    source: "hf",
    engine: "@qvac/transcription-whispercpp",
    license: "MIT",
    name: "",
    sizeBytes: 100000000,
    sha256: "f6f6f6f6223344f6f6f6f6f622334455f6f6f6f62233f6f6f6f6f6f6aabbccdd",
    quantization: "f16",
    params: "",
    tags: ["transcription", "tiny-ggml", "whisper-japanese", "japanese"],
    blobBinding: {
      coreKey,
      blockOffset: 21000,
      blockLength: 50,
      byteOffset: 200000000,
      byteLength: 100000000,
    },
  });

  t.is(model.engine, "whispercpp-transcription");
  t.is(model.addon, "whisper");
  t.is(model.modelId, "ja-tiny-ggml-model-f16.bin");

  t.is(exportName, "WHISPER_JAPANESE_TINY_F16");
});

// ---------------------------------------------------------------------------
// Embeddings: EmbeddingGemma 300M BF16 (canonical engine directly)
// ---------------------------------------------------------------------------

test("embeddings: EmbeddingGemma 300M BF16 — canonical engine name", (t: any) => {
  const coreKey = Buffer.from("a7".repeat(32), "hex");

  const { model, exportName } = processAndName({
    path: "unsloth/embeddinggemma-300m-GGUF/resolve/6661a6504c30d8304af13455cb4a5d4f5bc6011f/embeddinggemma-300M-BF16.gguf",
    source: "hf",
    engine: "llamacpp-embedding",
    license: "Apache-2.0",
    name: "",
    sizeBytes: 612429792,
    sha256: "95a1f284251f78a1409a9c9e52dd4026c2180b13a90a5ede2a878bb8141fba08",
    quantization: "BF16",
    params: "300M",
    tags: ["embedding", "bert", "embeddinggemma"],
    blobBinding: {
      coreKey,
      blockOffset: 22000,
      blockLength: 200,
      byteOffset: 210000000,
      byteLength: 612429792,
    },
  });

  t.is(model.engine, "llamacpp-embedding", "canonical engine used directly");
  t.is(model.addon, "embeddings");
  t.is(model.quantization, "BF16");
  t.is(model.params, "300M");
  t.is(
    model.sha256Checksum,
    "95a1f284251f78a1409a9c9e52dd4026c2180b13a90a5ede2a878bb8141fba08",
  );

  t.is(exportName, "EMBEDDINGGEMMA_300M_BF16");
});

// ---------------------------------------------------------------------------
// Shard grouping: full pipeline — 3 shard parts → 1 merged model
// ---------------------------------------------------------------------------

test("shard grouping: 3 shard parts merge into 1 model with shardMetadata", (t: any) => {
  const coreKey = Buffer.from("ab".repeat(32), "hex");

  // Simulate 3 shard entries processed from the registry (out of order)
  const shard2 = processRegistryModel({
    path: "qvac_models_compiled/ggml/medgemma-4b-it-Q4/2025-08-21/medgemma-4b-it-Q4_1-00002-of-00003.gguf",
    source: "s3",
    engine: "llamacpp-completion",
    license: "Apache-2.0",
    name: "",
    sizeBytes: 200000000,
    sha256: "shard2hash_aabb",
    quantization: "q4_1",
    params: "4B",
    tags: ["generation", "it", "medgemma", "shard"],
    blobBinding: {
      coreKey,
      blockOffset: 2000,
      blockLength: 200,
      byteOffset: 20000000,
      byteLength: 200000000,
    },
  } as any)!;

  const shard3 = processRegistryModel({
    path: "qvac_models_compiled/ggml/medgemma-4b-it-Q4/2025-08-21/medgemma-4b-it-Q4_1-00003-of-00003.gguf",
    source: "s3",
    engine: "llamacpp-completion",
    license: "Apache-2.0",
    name: "",
    sizeBytes: 150000000,
    sha256: "shard3hash_ccdd",
    quantization: "q4_1",
    params: "4B",
    tags: ["generation", "it", "medgemma", "shard"],
    blobBinding: {
      coreKey,
      blockOffset: 3000,
      blockLength: 150,
      byteOffset: 30000000,
      byteLength: 150000000,
    },
  } as any)!;

  const shard1 = processRegistryModel({
    path: "qvac_models_compiled/ggml/medgemma-4b-it-Q4/2025-08-21/medgemma-4b-it-Q4_1-00001-of-00003.gguf",
    source: "s3",
    engine: "llamacpp-completion",
    license: "Apache-2.0",
    name: "",
    sizeBytes: 250000000,
    sha256: "shard1hash_eeff",
    quantization: "q4_1",
    params: "4B",
    tags: ["generation", "it", "medgemma", "shard"],
    blobBinding: {
      coreKey,
      blockOffset: 1000,
      blockLength: 250,
      byteOffset: 10000000,
      byteLength: 250000000,
    },
  } as any)!;

  // Also add a non-sharded model (tensors.txt) to ensure it passes through
  const tensors = processRegistryModel({
    path: "qvac_models_compiled/ggml/medgemma-4b-it-Q4/2025-08-21/medgemma-4b-it-Q4_1.tensors.txt",
    source: "s3",
    engine: "llamacpp-completion",
    license: "Apache-2.0",
    name: "",
    sizeBytes: 12345,
    sha256: "tensorshash_0011",
    quantization: "q4_1",
    params: "4B",
    tags: ["generation", "it", "medgemma", "shard"],
    blobBinding: {
      coreKey,
      blockOffset: 9000,
      blockLength: 1,
      byteOffset: 80000000,
      byteLength: 12345,
    },
  } as any)!;

  // Verify shard detection on individual entries
  t.ok(shard1.isShardPart, "shard1 detected");
  t.ok(shard2.isShardPart, "shard2 detected");
  t.ok(shard3.isShardPart, "shard3 detected");
  t.absent(tensors.isShardPart, "tensors.txt is not a shard");

  // Feed all 4 entries (deliberately out of order) through groupShardedModels
  const grouped = groupShardedModels([shard2, tensors, shard3, shard1]);

  // Should produce 2 entries: the non-sharded tensors + 1 merged shard group
  t.is(grouped.length, 2, "3 shards merged into 1 + 1 non-sharded = 2 total");

  // First entry is the non-sharded tensors.txt (passed through unchanged)
  const tensorsOut = grouped[0]!;
  t.is(tensorsOut.modelId, "medgemma-4b-it-Q4_1.tensors.txt");
  t.absent(tensorsOut.shardMetadata, "non-sharded has no shardMetadata");

  // Second entry is the merged shard group
  const merged = grouped[1]!;

  // Merged model takes identity from first shard (sorted by shard number)
  t.is(merged.modelId, "medgemma-4b-it-Q4_1-00001-of-00003.gguf");
  t.is(merged.registrySource, "s3");
  t.is(merged.engine, "llamacpp-completion");
  t.is(merged.addon, "llm");
  t.is(merged.quantization, "q4_1");
  t.is(merged.params, "4B");

  // isShardPart/shardInfo stripped from the merged model
  t.absent(merged.isShardPart, "isShardPart removed after grouping");
  t.absent(merged.shardInfo, "shardInfo removed after grouping");

  // expectedSize is the SUM of all shards
  t.is(merged.expectedSize, 600000000, "250M + 200M + 150M = 600M total");

  // shardMetadata: one entry per shard, sorted by shard number
  t.ok(merged.shardMetadata, "merged has shardMetadata");
  t.is(merged.shardMetadata!.length, 3, "3 shard metadata entries");

  // Shard 1 (sorted first)
  const meta1 = merged.shardMetadata![0]!;
  t.is(meta1.filename, "medgemma-4b-it-Q4_1-00001-of-00003.gguf");
  t.is(meta1.expectedSize, 250000000);
  t.is(meta1.sha256Checksum, "shard1hash_eeff");
  t.is(meta1.blobCoreKey, "ab".repeat(32));
  t.is(meta1.blobBlockOffset, 1000);
  t.is(meta1.blobBlockLength, 250);
  t.is(meta1.blobByteOffset, 10000000);

  // Shard 2
  const meta2 = merged.shardMetadata![1]!;
  t.is(meta2.filename, "medgemma-4b-it-Q4_1-00002-of-00003.gguf");
  t.is(meta2.expectedSize, 200000000);
  t.is(meta2.sha256Checksum, "shard2hash_aabb");
  t.is(meta2.blobBlockOffset, 2000);
  t.is(meta2.blobByteOffset, 20000000);

  // Shard 3
  const meta3 = merged.shardMetadata![2]!;
  t.is(meta3.filename, "medgemma-4b-it-Q4_1-00003-of-00003.gguf");
  t.is(meta3.expectedSize, 150000000);
  t.is(meta3.sha256Checksum, "shard3hash_ccdd");
  t.is(meta3.blobBlockOffset, 3000);
  t.is(meta3.blobByteOffset, 30000000);
});

// ---------------------------------------------------------------------------
// Shard grouping → codegen: shardMetadata appears in generated output
// ---------------------------------------------------------------------------

test("shard grouping → codegen: generated output includes shardMetadata array", (t: any) => {
  const coreKey = Buffer.from("fa".repeat(32), "hex");

  const shard1 = processRegistryModel({
    path: "models/test-model/test-Q4-00001-of-00002.gguf",
    source: "s3",
    engine: "llamacpp-completion",
    license: "MIT",
    name: "",
    sizeBytes: 100,
    sha256: "hash_shard1",
    quantization: "q4",
    params: "1B",
    tags: ["generation", "instruct", "test"],
    blobBinding: {
      coreKey,
      blockOffset: 10,
      blockLength: 5,
      byteOffset: 100,
      byteLength: 500,
    },
  } as any)!;

  const shard2 = processRegistryModel({
    path: "models/test-model/test-Q4-00002-of-00002.gguf",
    source: "s3",
    engine: "llamacpp-completion",
    license: "MIT",
    name: "",
    sizeBytes: 100,
    sha256: "hash_shard2",
    quantization: "q4",
    params: "1B",
    tags: ["generation", "instruct", "test"],
    blobBinding: {
      coreKey,
      blockOffset: 20,
      blockLength: 5,
      byteOffset: 200,
      byteLength: 300,
    },
  } as any)!;

  const grouped = groupShardedModels([shard2, shard1]);
  t.is(grouped.length, 1, "2 shards grouped into 1");

  // Run through codegen
  const output = generateModelsFileContent(grouped);

  // Verify shardMetadata appears in the generated code
  t.ok(output.includes("shardMetadata"), "output contains shardMetadata");
  t.ok(
    output.includes("test-Q4-00001-of-00002.gguf"),
    "shard1 filename in metadata",
  );
  t.ok(
    output.includes("test-Q4-00002-of-00002.gguf"),
    "shard2 filename in metadata",
  );
  t.ok(output.includes("hash_shard1"), "shard1 sha256 in metadata");
  t.ok(output.includes("hash_shard2"), "shard2 sha256 in metadata");

  // The merged model name should have _SHARD suffix (from the naming step
  // detecting the shard pattern in the first shard's filename)
  // Actually the merged model still has the shard filename in modelId,
  // but isShardPart is stripped. The naming picks it up from path.
  t.ok(output.includes("_SHARD"), "export name includes _SHARD suffix");

  // expectedSize is the sum: 500 + 300 = 800
  t.ok(output.includes("expectedSize: 800"), "expectedSize is sum of shards");
});

// ---------------------------------------------------------------------------
// Diffusion: Stable Diffusion 2.1 Q8_0
// ---------------------------------------------------------------------------

test("diffusion: SD 2.1 Q8_0 — shortens stable-diffusion prefix", (t: any) => {
  const coreKey = Buffer.from("aa".repeat(32), "hex");

  const { model, exportName } = processAndName({
    path: "gpustack/stable-diffusion-v2-1-GGUF/resolve/12ddc22724f6da35f0b6006e459fae66eaf56931/stable-diffusion-v2-1-Q8_0.gguf",
    source: "hf",
    engine: "@qvac/diffusion-cpp",
    license: "openrail++",
    name: "",
    sizeBytes: 1300000000,
    sha256: "aa".repeat(32),
    quantization: "Q8_0",
    params: "1B",
    tags: ["generation", "diffusion"],
    blobBinding: {
      coreKey,
      blockOffset: 100,
      blockLength: 50,
      byteOffset: 1000000,
      byteLength: 1300000000,
    },
  });

  t.is(model.addon, "diffusion");
  t.is(model.engine, "sdcpp-generation");
  t.is(exportName, "SD_V2_1_1B_Q8_0");
});

// ---------------------------------------------------------------------------
// Diffusion: Stable Diffusion XL Q4_0
// ---------------------------------------------------------------------------

test("diffusion: SDXL Q4_0 — shortens stable-diffusion-xl prefix", (t: any) => {
  const coreKey = Buffer.from("bb".repeat(32), "hex");

  const { model, exportName } = processAndName({
    path: "gpustack/stable-diffusion-xl-base-1.0-GGUF/resolve/5f58340891db3ef66a79758c2dcddad92b1de169/stable-diffusion-xl-base-1.0-Q4_0.gguf",
    source: "hf",
    engine: "@qvac/diffusion-cpp",
    license: "openrail++",
    name: "",
    sizeBytes: 3500000000,
    sha256: "bb".repeat(32),
    quantization: "Q4_0",
    params: "3B",
    tags: ["generation", "diffusion"],
    blobBinding: {
      coreKey,
      blockOffset: 200,
      blockLength: 100,
      byteOffset: 2000000,
      byteLength: 3500000000,
    },
  });

  t.is(model.addon, "diffusion");
  t.is(exportName, "SDXL_BASE_1_0_3B_Q4_0");
});

// ---------------------------------------------------------------------------
// Diffusion: FLUX.2 Klein 4B Q4_0
// ---------------------------------------------------------------------------

test("diffusion: FLUX.2 Klein 4B Q4_0 — strips params+quant from family", (t: any) => {
  const coreKey = Buffer.from("cc".repeat(32), "hex");

  const { model, exportName } = processAndName({
    path: "unsloth/FLUX.2-klein-4B-GGUF/resolve/8342a6a97b2d18acae5d62124735c39ba23060e2/flux-2-klein-4b-Q4_0.gguf",
    source: "hf",
    engine: "@qvac/diffusion-cpp",
    license: "Apache-2.0",
    name: "",
    sizeBytes: 2500000000,
    sha256: "cc".repeat(32),
    quantization: "Q4_0",
    params: "4B",
    tags: ["generation", "diffusion"],
    blobBinding: {
      coreKey,
      blockOffset: 300,
      blockLength: 150,
      byteOffset: 3000000,
      byteLength: 2500000000,
    },
  });

  t.is(model.addon, "diffusion");
  t.is(exportName, "FLUX_2_KLEIN_4B_Q4_0");
});

// ---------------------------------------------------------------------------
// Diffusion: FLUX.2 VAE (tagged "vae")
// ---------------------------------------------------------------------------

test("diffusion: FLUX.2 VAE — vae tag produces _VAE suffix", (t: any) => {
  const coreKey = Buffer.from("dd".repeat(32), "hex");

  const { model, exportName } = processAndName({
    path: "black-forest-labs/FLUX.2-klein-4B/resolve/5e67da950fce4a097bc150c22958a05716994cea/vae/diffusion_pytorch_model.safetensors",
    source: "hf",
    engine: "@qvac/diffusion-cpp",
    license: "Apache-2.0",
    name: "",
    sizeBytes: 167000000,
    sha256: "dd".repeat(32),
    tags: ["vae"],
    blobBinding: {
      coreKey,
      blockOffset: 400,
      blockLength: 75,
      byteOffset: 4000000,
      byteLength: 167000000,
    },
  });

  t.is(model.addon, "diffusion");
  t.is(exportName, "FLUX_2_KLEIN_4B_VAE");
});
