import { createReadStream } from "bare-fs";
import { getServerLogger } from "@/logging";

const logger = getServerLogger();

const GGUF_MAGIC_LE = 0x46554747;
const GGUF_MAGIC_BE = 0x47475546;

const GGUF_TYPE = {
  UINT8: 0,
  INT8: 1,
  UINT16: 2,
  INT16: 3,
  UINT32: 4,
  INT32: 5,
  FLOAT32: 6,
  BOOL: 7,
  STRING: 8,
  ARRAY: 9,
  UINT64: 10,
  INT64: 11,
  FLOAT64: 12,
} as const;

const TYPE_SIZE: Record<number, number> = {
  [GGUF_TYPE.UINT8]: 1,
  [GGUF_TYPE.INT8]: 1,
  [GGUF_TYPE.UINT16]: 2,
  [GGUF_TYPE.INT16]: 2,
  [GGUF_TYPE.UINT32]: 4,
  [GGUF_TYPE.INT32]: 4,
  [GGUF_TYPE.FLOAT32]: 4,
  [GGUF_TYPE.BOOL]: 1,
  [GGUF_TYPE.UINT64]: 8,
  [GGUF_TYPE.INT64]: 8,
  [GGUF_TYPE.FLOAT64]: 8,
};

const MAX_KV_COUNT = 100_000;
const MAX_STRING_LEN = 100 * 1024 * 1024;
const MAX_ARRAY_LEN = 1_000_000_000;
const MAX_HEADER_SIZE = 4 * 1024 * 1024 * 1024;

export interface GGUFModelParams {
  architecture: string;
  blockCount: number;
  headCountKv: number;
  embeddingLength: number;
  headCount: number;
}

class NeedMoreDataError extends Error {
  constructor(
    public readonly currentOffset: number,
    public readonly bytesNeeded: number,
  ) {
    super(`Need more data at offset ${currentOffset}`);
    this.name = "NeedMoreDataError";
  }
}

function parseMetadataFromBuffer(buffer: Buffer): GGUFModelParams | null {
  const bufferLength = buffer.length;
  let offset = 0;
  let isBigEndian = false;

  function ensureBytes(n: number): void {
    if (offset + n > bufferLength) throw new NeedMoreDataError(offset, n);
  }

  function readU32(): number {
    ensureBytes(4);
    const val = isBigEndian
      ? buffer.readUInt32BE(offset)
      : buffer.readUInt32LE(offset);
    offset += 4;
    return val;
  }

  function readU64AsNumber(): number {
    ensureBytes(8);
    const val = isBigEndian
      ? buffer.readBigUInt64BE(offset)
      : buffer.readBigUInt64LE(offset);
    offset += 8;
    if (val > BigInt(Number.MAX_SAFE_INTEGER)) return 0;
    return Number(val);
  }

  function readString(): string {
    const len = readU64AsNumber();
    if (len > MAX_STRING_LEN) {
      offset += len;
      return "";
    }
    ensureBytes(len);
    const str = buffer.toString("utf8", offset, offset + len);
    offset += len;
    return str;
  }

  function skipBytes(n: number): void {
    ensureBytes(n);
    offset += n;
  }

  function readNumericValue(valueType: number): number {
    const size = TYPE_SIZE[valueType];
    if (size !== undefined) {
      if (valueType === GGUF_TYPE.UINT32) return readU32();
      if (valueType === GGUF_TYPE.UINT64 || valueType === GGUF_TYPE.INT64)
        return readU64AsNumber();
      if (valueType === GGUF_TYPE.FLOAT32) {
        ensureBytes(4);
        const val = isBigEndian
          ? buffer.readFloatBE(offset)
          : buffer.readFloatLE(offset);
        offset += 4;
        return val;
      }
      ensureBytes(size);
      const val = isBigEndian
        ? buffer.readUIntBE(offset, size)
        : buffer.readUIntLE(offset, size);
      offset += size;
      return val;
    }
    return 0;
  }

  function skipValue(valueType: number): void {
    const size = TYPE_SIZE[valueType];
    if (size !== undefined) {
      skipBytes(size);
      return;
    }
    if (valueType === GGUF_TYPE.STRING) {
      readString();
      return;
    }
    if (valueType === GGUF_TYPE.ARRAY) {
      const arrayType = readU32();
      const arrayLen = readU64AsNumber();
      if (arrayLen > MAX_ARRAY_LEN) throw new Error("Array too large");
      const elementSize = TYPE_SIZE[arrayType];
      if (elementSize !== undefined) {
        skipBytes(arrayLen * elementSize);
      } else if (arrayType === GGUF_TYPE.STRING) {
        for (let i = 0; i < arrayLen; i++) readString();
      } else {
        throw new Error(`Unknown array element type: ${arrayType}`);
      }
    }
  }

  // Magic
  ensureBytes(4);
  const magic = buffer.readUInt32LE(offset);
  if (magic === GGUF_MAGIC_LE) isBigEndian = false;
  else if (magic === GGUF_MAGIC_BE) isBigEndian = true;
  else return null;
  offset += 4;

  const version = readU32();
  if (version !== 2 && version !== 3) return null;

  readU64AsNumber(); // tensor_count
  const kvCount = readU64AsNumber();
  if (kvCount > MAX_KV_COUNT) return null;

  // Keys we're looking for (architecture-prefixed)
  let architecture = "";
  let blockCount = 0;
  let headCountKv = 0;
  let embeddingLength = 0;
  let headCount = 0;

  for (let i = 0; i < kvCount; i++) {
    const key = readString();
    const valueType = readU32();

    if (key === "general.architecture") {
      architecture = valueType === GGUF_TYPE.STRING ? readString() : "";
      if (valueType !== GGUF_TYPE.STRING) skipValue(valueType);
      continue;
    }

    // Match {arch}.block_count, {arch}.attention.head_count_kv, etc.
    // We don't know the arch prefix yet on first pass, so match by suffix
    if (key.endsWith(".block_count")) {
      blockCount = readNumericValue(valueType);
      continue;
    }
    if (key.endsWith(".attention.head_count_kv")) {
      headCountKv = readNumericValue(valueType);
      continue;
    }
    if (key.endsWith(".embedding_length")) {
      embeddingLength = readNumericValue(valueType);
      continue;
    }
    if (key.endsWith(".attention.head_count")) {
      headCount = readNumericValue(valueType);
      continue;
    }

    skipValue(valueType);
  }

  if (blockCount === 0 || headCount === 0 || embeddingLength === 0) {
    return null;
  }

  // If head_count_kv is 0, assume MHA (head_count_kv = head_count)
  if (headCountKv === 0) {
    headCountKv = headCount;
  }

  return { architecture, blockCount, headCountKv, embeddingLength, headCount };
}

export async function readGGUFModelParams(
  filePath: string,
): Promise<GGUFModelParams | null> {
  const stream = createReadStream(filePath);
  const chunks: Buffer[] = [];
  let totalRead = 0;
  let destroyed = false;

  function destroy(): void {
    if (!destroyed) {
      destroyed = true;
      stream.destroy();
    }
  }

  try {
    for await (const chunk of stream) {
      chunks.push(chunk as Buffer);
      totalRead += (chunk as Buffer).length;

      if (totalRead >= 24) {
        try {
          const buf = Buffer.concat(chunks);
          const result = parseMetadataFromBuffer(buf);
          destroy();
          return result;
        } catch (error) {
          if (error instanceof NeedMoreDataError) {
            if (totalRead >= MAX_HEADER_SIZE) {
              logger.warn("GGUF header too large for metadata extraction");
              destroy();
              return null;
            }
            continue;
          }
          throw error;
        }
      }
    }

    logger.warn("GGUF file ended before metadata could be parsed");
    return null;
  } catch (error) {
    logger.warn(
      `Failed to read GGUF metadata: ${error instanceof Error ? error.message : String(error)}`,
    );
    return null;
  } finally {
    destroy();
  }
}

/**
 * Compute exact KV cache bytes per token from GGUF model parameters.
 * Formula: 2 (K+V) * n_layer * n_kv_heads * head_dim * dtype_size
 * dtype_size = 2 for f16 (default KV cache type in llama.cpp)
 */
export function computeExactKvBytesPerToken(
  params: GGUFModelParams,
  kvCacheDtypeSize = 2,
): number {
  const headDim = params.embeddingLength / params.headCount;
  return (
    2 * params.blockCount * params.headCountKv * headDim * kvCacheDtypeSize
  );
}
