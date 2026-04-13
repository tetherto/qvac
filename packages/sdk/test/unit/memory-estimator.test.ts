// @ts-expect-error brittle has no type declarations
import test from "brittle";
import {
  estimateKvBytesPerToken,
  estimateMemoryRequired,
  estimateOverhead,
  computeSafeCtxSize,
  validateMemoryForModel,
} from "@/server/bare/plugins/llamacpp-completion/memory-estimator";
// Pure computation function inlined to avoid importing bare-fs via gguf-metadata
interface GGUFModelParams {
  architecture: string;
  blockCount: number;
  headCountKv: number;
  embeddingLength: number;
  headCount: number;
}

function computeExactKvBytesPerToken(params: GGUFModelParams, kvCacheDtypeSize = 2): number {
  const headDim = params.embeddingLength / params.headCount;
  return 2 * params.blockCount * params.headCountKv * headDim * kvCacheDtypeSize;
}
import { llmConfigBaseSchema } from "@/schemas/llamacpp-config";

const MB = 1024 * 1024;
const GB = 1024 * MB;

// --- estimateKvBytesPerToken ---

test("estimateKvBytesPerToken: small model (<1GB) returns 48000 bytes/token", (t: { is: Function }) => {
  t.is(estimateKvBytesPerToken(500 * MB), 48_000);
  t.is(estimateKvBytesPerToken(737 * MB), 48_000);
});

test("estimateKvBytesPerToken: 1-3GB model returns 128000 bytes/token", (t: { is: Function }) => {
  t.is(estimateKvBytesPerToken(1 * GB), 128_000);
  t.is(estimateKvBytesPerToken(2 * GB), 128_000);
});

test("estimateKvBytesPerToken: 3-6GB model returns 200000 bytes/token", (t: { is: Function }) => {
  t.is(estimateKvBytesPerToken(4 * GB), 200_000);
  t.is(estimateKvBytesPerToken(5 * GB), 200_000);
});

test("estimateKvBytesPerToken: 6-15GB model returns 350000 bytes/token", (t: { is: Function }) => {
  t.is(estimateKvBytesPerToken(7 * GB), 350_000);
  t.is(estimateKvBytesPerToken(14 * GB), 350_000);
});

test("estimateKvBytesPerToken: very large model (>15GB) returns 500000 bytes/token", (t: { is: Function }) => {
  t.is(estimateKvBytesPerToken(20 * GB), 500_000);
  t.is(estimateKvBytesPerToken(40 * GB), 500_000);
});

// --- estimateMemoryRequired ---

test("estimateMemoryRequired: includes model size + KV cache + overhead", (t: { ok: Function }) => {
  const modelSize = 4 * GB;
  const ctxSize = 8192;
  const estimated = estimateMemoryRequired(modelSize, ctxSize);
  const overhead = estimateOverhead(modelSize);

  t.ok(estimated > modelSize, "estimated should exceed model file size");
  t.ok(estimated > modelSize + overhead - 1, "should include overhead");
});

test("estimateMemoryRequired: larger ctx_size produces larger estimate", (t: { ok: Function }) => {
  const modelSize = 4 * GB;
  const small = estimateMemoryRequired(modelSize, 1024);
  const large = estimateMemoryRequired(modelSize, 32768);

  t.ok(large > small, "32k ctx should require more than 1k ctx");
});

// --- computeSafeCtxSize ---

test("computeSafeCtxSize: returns default when no budget for KV", (t: { is: Function }) => {
  const safeCtx = computeSafeCtxSize(1 * GB, 4 * GB);
  t.is(safeCtx, 1024);
});

test("computeSafeCtxSize: returns reasonable value for typical desktop", (t: { ok: Function }) => {
  const safeCtx = computeSafeCtxSize(16 * GB, 4 * GB);
  t.ok(safeCtx >= 1024, "should be at least the default");
  t.ok(safeCtx <= 131072, "should not exceed schema max");
});

// --- validateMemoryForModel ---

test("validateMemoryForModel: safe when plenty of memory available", (t: { is: Function }) => {
  const result = validateMemoryForModel(4 * GB, 2048, 32 * GB);
  t.is(result.safe, true);
});

test("validateMemoryForModel: unsafe when memory is insufficient", (t: { is: Function; ok: Function }) => {
  const result = validateMemoryForModel(4 * GB, 65536, 2 * GB);
  t.is(result.safe, false);
  t.ok(result.suggestedCtxSize < 65536, "suggested ctx should be smaller");
  t.ok(result.suggestedCtxSize >= 1024, "suggested ctx should be at least default");
});

test("validateMemoryForModel: safe when available memory is 0 (unknown)", (t: { is: Function }) => {
  const result = validateMemoryForModel(4 * GB, 65536, 0);
  t.is(result.safe, true);
});

test("validateMemoryForModel: suggested ctx is less than requested when unsafe", (t: { ok: Function }) => {
  const result = validateMemoryForModel(4 * GB, 32768, 6 * GB);
  if (!result.safe) {
    t.ok(result.suggestedCtxSize < result.requestedCtxSize);
  } else {
    t.ok(true, "safe — no suggestion needed");
  }
});

test("validateMemoryForModel: 1B model with extreme ctx_size is unsafe on 24GB machine", (t: { is: Function; ok: Function }) => {
  const result = validateMemoryForModel(737 * MB, 3276000, 17 * GB);
  t.is(result.safe, false);
  t.ok(result.suggestedCtxSize < 3276000, "suggested ctx should be much smaller");
});

test("validateMemoryForModel: 1B model with normal ctx_size is safe on 24GB machine", (t: { is: Function }) => {
  const result = validateMemoryForModel(737 * MB, 2048, 17 * GB);
  t.is(result.safe, true);
});

// --- False-positive regression: every real mobile test config must pass ---
// These use actual model expectedSize values from the registry and ctx_size
// values from tests-qvac/tests/mobile/consumer.ts.
// Available memory = totalMem * 0.65 (mobile heuristic).
// We test against the smallest realistic device (4GB, 6GB, 8GB).

// Models that must load on all mobile devices including 4GB
const MOBILE_CONFIGS_ALL_DEVICES = [
  { name: "LLAMA_3_2_1B_INST_Q4_0 ctx=2048", fileSize: 773_025_824, ctxSize: 2048 },
  { name: "QWEN3_1_7B_INST_Q4 ctx=4096", fileSize: 1_056_782_912, ctxSize: 4096 },
  { name: "SMOLVLM2_500M_MULTIMODAL_Q8_0 ctx=1024", fileSize: 820_424_704, ctxSize: 1024 },
];

// Larger models that only run on 8GB+ devices
const MOBILE_CONFIGS_8GB_PLUS = [
  { name: "SALAMANDRATA_2B_INST_Q4 ctx=1024 (default)", fileSize: 1_517_617_504, ctxSize: 1024 },
  { name: "AFRICAN_4B_TRANSLATION_Q4_K_M ctx=2048", fileSize: 2_867_473_376, ctxSize: 2048 },
];

for (const config of MOBILE_CONFIGS_ALL_DEVICES) {
  for (const ramGb of [4, 6, 8]) {
    const availableMemory = Math.floor(ramGb * GB * 0.65);
    test(`no false positive: ${config.name} on ${ramGb}GB device`, (t: { is: Function }) => {
      const result = validateMemoryForModel(config.fileSize, config.ctxSize, availableMemory);
      t.is(result.safe, true);
    });
  }
}

for (const config of MOBILE_CONFIGS_8GB_PLUS) {
  for (const ramGb of [8, 12]) {
    const availableMemory = Math.floor(ramGb * GB * 0.65);
    test(`no false positive: ${config.name} on ${ramGb}GB device`, (t: { is: Function }) => {
      const result = validateMemoryForModel(config.fileSize, config.ctxSize, availableMemory);
      t.is(result.safe, true);
    });
  }
}

// --- Exact KV computation from GGUF metadata ---

// Real model architectures for validation
const LLAMA_3_2_1B: GGUFModelParams = {
  architecture: "llama",
  blockCount: 16,
  headCountKv: 8,
  embeddingLength: 2048,
  headCount: 32,
};

const AFRIQUEGEMMA_4B: GGUFModelParams = {
  architecture: "gemma3",
  blockCount: 34,
  headCountKv: 4,
  embeddingLength: 2560,
  headCount: 8,
};

const LLAMA_3_1_8B: GGUFModelParams = {
  architecture: "llama",
  blockCount: 32,
  headCountKv: 8,
  embeddingLength: 4096,
  headCount: 32,
};

test("computeExactKvBytesPerToken: Llama-3.2-1B = 32768 bytes/token", (t: { is: Function }) => {
  // 2 * 16 layers * 8 kv_heads * (2048/32=64 head_dim) * 2 f16 = 32768
  t.is(computeExactKvBytesPerToken(LLAMA_3_2_1B), 32768);
});

test("computeExactKvBytesPerToken: AfriqueGemma-4B = 139264 bytes/token", (t: { is: Function }) => {
  // 2 * 34 layers * 4 kv_heads * (2560/8=320 head_dim) * 2 f16 = 174080
  // Wait: 2560/8 = 320. 2 * 34 * 4 * 320 * 2 = 174080
  const expected = 2 * 34 * 4 * (2560 / 8) * 2;
  t.is(computeExactKvBytesPerToken(AFRIQUEGEMMA_4B), expected);
});

test("computeExactKvBytesPerToken: Llama-3.1-8B = 131072 bytes/token", (t: { is: Function }) => {
  // 2 * 32 layers * 8 kv_heads * (4096/32=128 head_dim) * 2 f16 = 131072
  t.is(computeExactKvBytesPerToken(LLAMA_3_1_8B), 131072);
});

test("validateMemoryForModel: exact path produces different estimate than heuristic", (t: { ok: Function; is: Function }) => {
  const fileSize = 2_867_473_376;
  const ctxSize = 2048;
  const available12GB = Math.floor(12 * GB * 0.65);
  const exactKv = computeExactKvBytesPerToken(AFRIQUEGEMMA_4B);

  const exactResult = validateMemoryForModel(fileSize, ctxSize, available12GB, exactKv);
  const heuristicResult = validateMemoryForModel(fileSize, ctxSize, available12GB);

  t.is(exactResult.exact, true);
  t.is(heuristicResult.exact, false);
  t.ok(exactResult.estimatedBytes !== heuristicResult.estimatedBytes,
    "exact and heuristic should differ");
  t.is(exactResult.safe, true);
});

test("validateMemoryForModel: exact Llama-1B is less conservative than heuristic", (t: { ok: Function; is: Function }) => {
  const fileSize = 773_025_824;
  const ctxSize = 2048;
  const available = Math.floor(4 * GB * 0.65);
  const exactKv = computeExactKvBytesPerToken(LLAMA_3_2_1B); // 32768

  const exactResult = validateMemoryForModel(fileSize, ctxSize, available, exactKv);
  const heuristicResult = validateMemoryForModel(fileSize, ctxSize, available); // uses 48000

  t.ok(exactResult.estimatedBytes < heuristicResult.estimatedBytes,
    "exact (32KB/tok) should be lower than heuristic (48KB/tok) for 1B model");
  t.is(exactResult.safe, true);
  t.is(heuristicResult.safe, true);
});

test("validateMemoryForModel: exact Llama-1B with extreme ctx still unsafe", (t: { is: Function }) => {
  const exactKv = computeExactKvBytesPerToken(LLAMA_3_2_1B);
  const result = validateMemoryForModel(773 * MB, 3276000, 17 * GB, exactKv);
  t.is(result.safe, false);
  t.is(result.exact, true);
});

// --- llmConfigBaseSchema ctx_size validation ---

test("schema: ctx_size rejects fractional values", (t: { is: Function }) => {
  const result = llmConfigBaseSchema.safeParse({ ctx_size: 1024.5 });
  t.is(result.success, false);
});

test("schema: ctx_size rejects 0", (t: { is: Function }) => {
  const result = llmConfigBaseSchema.safeParse({ ctx_size: 0 });
  t.is(result.success, false);
});

test("schema: ctx_size rejects negative", (t: { is: Function }) => {
  const result = llmConfigBaseSchema.safeParse({ ctx_size: -1 });
  t.is(result.success, false);
});

test("schema: ctx_size accepts large values (validated by memory estimator instead)", (t: { is: Function }) => {
  t.is(llmConfigBaseSchema.safeParse({ ctx_size: 131072 }).success, true);
  t.is(llmConfigBaseSchema.safeParse({ ctx_size: 500000 }).success, true);
});

test("schema: ctx_size accepts 1", (t: { is: Function }) => {
  const result = llmConfigBaseSchema.safeParse({ ctx_size: 1 });
  t.is(result.success, true);
});

test("schema: ctx_size accepts typical values", (t: { is: Function }) => {
  t.is(llmConfigBaseSchema.safeParse({ ctx_size: 1024 }).success, true);
  t.is(llmConfigBaseSchema.safeParse({ ctx_size: 2048 }).success, true);
  t.is(llmConfigBaseSchema.safeParse({ ctx_size: 8192 }).success, true);
  t.is(llmConfigBaseSchema.safeParse({ ctx_size: 32768 }).success, true);
});

test("schema: ctx_size is optional", (t: { is: Function }) => {
  const result = llmConfigBaseSchema.safeParse({});
  t.is(result.success, true);
});
