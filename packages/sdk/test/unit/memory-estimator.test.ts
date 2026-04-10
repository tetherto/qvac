// @ts-expect-error brittle has no type declarations
import test from "brittle";
import {
  estimateKvBytesPerToken,
  estimateMemoryRequired,
  computeSafeCtxSize,
  validateMemoryForModel,
} from "@/server/bare/plugins/llamacpp-completion/memory-estimator";
import { llmConfigBaseSchema } from "@/schemas/llamacpp-config";

const MB = 1024 * 1024;
const GB = 1024 * MB;

// --- estimateKvBytesPerToken ---

test("estimateKvBytesPerToken: small model (<2GB) returns 256 bytes/token", (t: { is: Function }) => {
  t.is(estimateKvBytesPerToken(1 * GB), 256);
  t.is(estimateKvBytesPerToken(500 * MB), 256);
});

test("estimateKvBytesPerToken: medium model (2-5GB) returns 512 bytes/token", (t: { is: Function }) => {
  t.is(estimateKvBytesPerToken(3 * GB), 512);
  t.is(estimateKvBytesPerToken(4.9 * GB), 512);
});

test("estimateKvBytesPerToken: large model (5-15GB) returns 1024 bytes/token", (t: { is: Function }) => {
  t.is(estimateKvBytesPerToken(7 * GB), 1024);
  t.is(estimateKvBytesPerToken(14 * GB), 1024);
});

test("estimateKvBytesPerToken: very large model (>15GB) returns 2048 bytes/token", (t: { is: Function }) => {
  t.is(estimateKvBytesPerToken(20 * GB), 2048);
  t.is(estimateKvBytesPerToken(40 * GB), 2048);
});

// --- estimateMemoryRequired ---

test("estimateMemoryRequired: includes model size + KV cache + overhead", (t: { ok: Function }) => {
  const modelSize = 4 * GB;
  const ctxSize = 8192;
  const estimated = estimateMemoryRequired(modelSize, ctxSize);

  t.ok(estimated > modelSize, "estimated should exceed model file size");
  t.ok(estimated > modelSize + 512 * MB, "should include overhead buffer");
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
