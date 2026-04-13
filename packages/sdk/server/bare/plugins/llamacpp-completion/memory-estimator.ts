import { LLM_CONFIG_DEFAULTS } from "@/schemas/llamacpp-config";

const BYTES_PER_MB = 1024 * 1024;
const BYTES_PER_GB = 1024 * BYTES_PER_MB;
const MEMORY_USAGE_THRESHOLD = 0.80;
const MAX_CTX_SIZE = 131072;
const OVERHEAD_FIXED_BYTES = 128 * BYTES_PER_MB;
const OVERHEAD_MODEL_FRACTION = 0.10;

// llama.cpp KV cache formula: 2 (K+V) * n_layer * n_kv_heads * head_dim * dtype_size
// Since we can't read GGUF metadata from JS, we estimate based on model file size.
// These brackets are calibrated from actual model architectures with f16 KV cache:
//   Llama-3.2-1B  (737MB Q4):  32,768 bytes/token
//   Llama-3.2-3B  (~2GB Q4):  114,688 bytes/token
//   Llama-3.1-8B  (~4.5GB Q4): 131,072 bytes/token
//   Phi-3-mini-3.8B (~2.2GB):  393,216 bytes/token (MHA, not GQA)
// We use conservative (high) estimates to avoid false negatives.

interface KvBytesPerTokenBracket {
  maxFileSize: number;
  bytesPerToken: number;
}

const KV_BRACKETS: KvBytesPerTokenBracket[] = [
  { maxFileSize: 1 * BYTES_PER_GB, bytesPerToken: 48_000 },
  { maxFileSize: 3 * BYTES_PER_GB, bytesPerToken: 128_000 },
  { maxFileSize: 6 * BYTES_PER_GB, bytesPerToken: 200_000 },
  { maxFileSize: 15 * BYTES_PER_GB, bytesPerToken: 350_000 },
  { maxFileSize: Infinity, bytesPerToken: 500_000 },
];

export function estimateKvBytesPerToken(modelFileSize: number): number {
  for (const bracket of KV_BRACKETS) {
    if (modelFileSize < bracket.maxFileSize) return bracket.bytesPerToken;
  }
  return KV_BRACKETS[KV_BRACKETS.length - 1]!.bytesPerToken;
}

export function estimateOverhead(modelFileSize: number): number {
  return OVERHEAD_FIXED_BYTES + Math.floor(modelFileSize * OVERHEAD_MODEL_FRACTION);
}

export function estimateMemoryRequired(
  modelFileSize: number,
  ctxSize: number,
): number {
  const kvBytesPerToken = estimateKvBytesPerToken(modelFileSize);
  const kvCacheBytes = ctxSize * kvBytesPerToken;
  return modelFileSize + kvCacheBytes + estimateOverhead(modelFileSize);
}

export function computeSafeCtxSize(
  availableMemory: number,
  modelFileSize: number,
): number {
  const kvBytesPerToken = estimateKvBytesPerToken(modelFileSize);
  const usableBudget = availableMemory * MEMORY_USAGE_THRESHOLD;
  const budgetForKv = usableBudget - modelFileSize - estimateOverhead(modelFileSize);

  if (budgetForKv <= 0) return LLM_CONFIG_DEFAULTS.ctx_size;

  const safeCtx = Math.floor(budgetForKv / kvBytesPerToken);
  return Math.min(Math.max(safeCtx, LLM_CONFIG_DEFAULTS.ctx_size), MAX_CTX_SIZE);
}

export interface MemoryValidationResult {
  safe: boolean;
  estimatedBytes: number;
  availableBytes: number;
  requestedCtxSize: number;
  suggestedCtxSize: number;
}

export function validateMemoryForModel(
  modelFileSize: number,
  ctxSize: number,
  availableMemory: number,
): MemoryValidationResult {
  const estimatedBytes = estimateMemoryRequired(modelFileSize, ctxSize);
  const threshold = availableMemory * MEMORY_USAGE_THRESHOLD;
  const safe = availableMemory <= 0 || estimatedBytes <= threshold;
  const suggestedCtxSize = safe
    ? ctxSize
    : computeSafeCtxSize(availableMemory, modelFileSize);

  return {
    safe,
    estimatedBytes,
    availableBytes: availableMemory,
    requestedCtxSize: ctxSize,
    suggestedCtxSize,
  };
}
