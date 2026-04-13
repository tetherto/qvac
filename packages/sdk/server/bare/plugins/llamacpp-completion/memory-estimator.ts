import { LLM_CONFIG_DEFAULTS } from "@/schemas/llamacpp-config";

const BYTES_PER_MB = 1024 * 1024;
const BYTES_PER_GB = 1024 * BYTES_PER_MB;
const MEMORY_USAGE_THRESHOLD = 0.80;
const MAX_CTX_SIZE = 131072;
const OVERHEAD_FIXED_BYTES = 128 * BYTES_PER_MB;
const OVERHEAD_MODEL_FRACTION = 0.10;

// Fallback heuristic brackets when GGUF metadata is unavailable.
// Calibrated from actual model architectures with f16 KV cache:
//   Llama-3.2-1B  (737MB Q4):  32,768 bytes/token
//   Llama-3.2-3B  (~2GB Q4):  114,688 bytes/token
//   Llama-3.1-8B  (~4.5GB Q4): 131,072 bytes/token
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

function resolveKvBytesPerToken(
  modelFileSize: number,
  exactKvBytesPerToken?: number,
): number {
  if (exactKvBytesPerToken !== undefined && exactKvBytesPerToken > 0) {
    return exactKvBytesPerToken;
  }
  return estimateKvBytesPerToken(modelFileSize);
}

export function estimateMemoryRequired(
  modelFileSize: number,
  ctxSize: number,
  exactKvBytesPerToken?: number,
): number {
  const kvBytesPerToken = resolveKvBytesPerToken(modelFileSize, exactKvBytesPerToken);
  const kvCacheBytes = ctxSize * kvBytesPerToken;
  return modelFileSize + kvCacheBytes + estimateOverhead(modelFileSize);
}

export function computeSafeCtxSize(
  availableMemory: number,
  modelFileSize: number,
  exactKvBytesPerToken?: number,
): number {
  const kvBytesPerToken = resolveKvBytesPerToken(modelFileSize, exactKvBytesPerToken);
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
  exact: boolean;
}

export function validateMemoryForModel(
  modelFileSize: number,
  ctxSize: number,
  availableMemory: number,
  exactKvBytesPerToken?: number,
): MemoryValidationResult {
  const estimatedBytes = estimateMemoryRequired(modelFileSize, ctxSize, exactKvBytesPerToken);
  const threshold = availableMemory * MEMORY_USAGE_THRESHOLD;
  const safe = availableMemory <= 0 || estimatedBytes <= threshold;
  const suggestedCtxSize = safe
    ? ctxSize
    : computeSafeCtxSize(availableMemory, modelFileSize, exactKvBytesPerToken);

  return {
    safe,
    estimatedBytes,
    availableBytes: availableMemory,
    requestedCtxSize: ctxSize,
    suggestedCtxSize,
    exact: exactKvBytesPerToken !== undefined && exactKvBytesPerToken > 0,
  };
}
