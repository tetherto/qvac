import { promises as fsPromises, createReadStream } from "bare-fs";
import path from "bare-path";
import { getServerLogger } from "@/logging";
import { ModelLoadFailedError } from "@/utils/errors-server";

const logger = getServerLogger();

// GGUF value types
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

// Type sizes in bytes
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

// Limits to prevent DoS/corruption issues
const LIMITS = {
  MAX_KV_COUNT: 100_000,
  MAX_TENSOR_COUNT: 1_000_000,
  MAX_STRING_LEN: 100 * 1024 * 1024, // 100MB for tokenizer vocab
  MAX_TENSOR_NAME_LEN: 64 * 1024, // 64KB for tensor names
  MAX_ARRAY_LEN: 1_000_000_000, // 1B elements
  MAX_DIMS: 32,
  MAX_HEADER_SIZE: 4 * 1024 * 1024 * 1024, // 4GB max header
};

// Magic bytes for endianness detection
const GGUF_MAGIC_LE = 0x46554747; // "GGUF" little-endian
const GGUF_MAGIC_BE = 0x47475546; // "FUGG" big-endian

// File-local error for streaming parser control flow
// Used to signal "keep reading chunks" rather than an actual failure
class NeedMoreDataError extends Error {
  constructor(
    public readonly currentOffset: number,
    public readonly bytesNeeded: number,
  ) {
    super(
      `Need more data: offset ${currentOffset} requires ${bytesNeeded} more bytes`,
    );
    this.name = "NeedMoreDataError";
  }
}

function parseGGUFHeader(buffer: Buffer): string[] {
  const bufferLength = buffer.length;
  let offset = 0;
  let isBigEndian = false;

  function ensureBytes(needed: number): void {
    if (offset + needed > bufferLength) {
      throw new NeedMoreDataError(offset, needed);
    }
  }

  function readU32(): number {
    ensureBytes(4);
    const val = isBigEndian
      ? buffer.readUInt32BE(offset)
      : buffer.readUInt32LE(offset);
    offset += 4;
    return val;
  }

  function readU64(): bigint {
    ensureBytes(8);
    const val = isBigEndian
      ? buffer.readBigUInt64BE(offset)
      : buffer.readBigUInt64LE(offset);
    offset += 8;
    return val;
  }

  function readU64AsNumber(): number {
    const val = readU64();
    if (val > BigInt(Number.MAX_SAFE_INTEGER)) {
      throw new ModelLoadFailedError(`Value ${val} exceeds safe integer range`);
    }
    return Number(val);
  }

  function skipBytes(n: number): void {
    ensureBytes(n);
    offset += n;
  }

  function skipString(): void {
    const len = readU64AsNumber();
    if (len > LIMITS.MAX_STRING_LEN) {
      throw new ModelLoadFailedError(
        `String length ${len} exceeds limit ${LIMITS.MAX_STRING_LEN}`,
      );
    }
    skipBytes(len);
  }

  function readTensorName(): string {
    const len = readU64AsNumber();
    if (len > LIMITS.MAX_TENSOR_NAME_LEN) {
      logger.warn(`Tensor name length ${len} exceeds limit, truncating`);
      skipBytes(len);
      return "";
    }
    ensureBytes(len);
    const name = buffer.toString("utf8", offset, offset + len);
    offset += len;
    return name;
  }

  function skipValue(valueType: number): void {
    const size = TYPE_SIZE[valueType];
    if (size !== undefined) {
      skipBytes(size);
      return;
    }

    if (valueType === GGUF_TYPE.STRING) {
      skipString();
      return;
    }

    if (valueType === GGUF_TYPE.ARRAY) {
      const arrayType = readU32();
      const arrayLen = readU64AsNumber();

      if (arrayLen > LIMITS.MAX_ARRAY_LEN) {
        throw new ModelLoadFailedError(
          `Array length ${arrayLen} exceeds limit ${LIMITS.MAX_ARRAY_LEN}`,
        );
      }

      const elementSize = TYPE_SIZE[arrayType];
      if (elementSize !== undefined) {
        // Fixed-size elements
        skipBytes(arrayLen * elementSize);
      } else if (arrayType === GGUF_TYPE.STRING) {
        // Array of strings
        for (let i = 0; i < arrayLen; i++) {
          skipString();
        }
      } else if (arrayType === GGUF_TYPE.ARRAY) {
        throw new ModelLoadFailedError("Nested arrays not supported");
      } else {
        throw new ModelLoadFailedError(
          `Unknown array element type: ${arrayType}`,
        );
      }
      return;
    }

    throw new ModelLoadFailedError(`Unknown value type: ${valueType}`);
  }

  // Parse header
  ensureBytes(4);
  const magicLE = buffer.readUInt32LE(offset);

  if (magicLE === GGUF_MAGIC_LE) {
    isBigEndian = false;
  } else if (magicLE === GGUF_MAGIC_BE) {
    isBigEndian = true;
    logger.debug("Detected big-endian GGUF file");
  } else {
    throw new ModelLoadFailedError(
      `Invalid GGUF file - magic number mismatch (got 0x${magicLE.toString(16)})`,
    );
  }
  offset += 4;

  // Version
  const version = readU32();

  if (version !== 2 && version !== 3) {
    throw new ModelLoadFailedError(`Unsupported GGUF version: ${version}`);
  }

  // Tensor count and KV count
  const tensorCount = readU64AsNumber();
  const kvCount = readU64AsNumber();

  if (tensorCount > LIMITS.MAX_TENSOR_COUNT) {
    throw new ModelLoadFailedError(
      `Tensor count ${tensorCount} exceeds limit ${LIMITS.MAX_TENSOR_COUNT}`,
    );
  }
  if (kvCount > LIMITS.MAX_KV_COUNT) {
    throw new ModelLoadFailedError(
      `KV count ${kvCount} exceeds limit ${LIMITS.MAX_KV_COUNT}`,
    );
  }

  // Skip all KV pairs
  for (let i = 0; i < kvCount; i++) {
    skipString();
    const valueType = readU32();
    skipValue(valueType);
  }

  logger.debug(
    `KV section complete at offset ${offset}, reading tensor names...`,
  );

  const tensorNames: string[] = [];

  for (let i = 0; i < tensorCount; i++) {
    const name = readTensorName();
    if (name) {
      tensorNames.push(name);
    }

    // n_dims (u32)
    const nDims = readU32();
    if (nDims > LIMITS.MAX_DIMS) {
      throw new ModelLoadFailedError(
        `Tensor dimensions ${nDims} exceeds limit ${LIMITS.MAX_DIMS}`,
      );
    }

    // shape: nDims * u64
    skipBytes(nDims * 8);

    // dtype (u32)
    skipBytes(4);

    // offset (u64)
    skipBytes(8);
  }

  logger.debug(`Parsed ${tensorNames.length} tensor names successfully`);

  return tensorNames;
}

async function extractTensorNamesFromHeader(
  filePath: string,
): Promise<string[]> {
  const stream = createReadStream(filePath);
  const chunks: Buffer[] = [];
  let totalRead = 0;
  let streamDestroyed = false;

  function destroyStream(): void {
    if (!streamDestroyed) {
      streamDestroyed = true;
      stream.destroy();
    }
  }

  try {
    for await (const chunk of stream) {
      chunks.push(chunk as Buffer);
      totalRead += (chunk as Buffer).length;

      // Only attempt parsing once we have enough data for the basic header
      if (totalRead >= 24) {
        try {
          const buffer = Buffer.concat(chunks);
          const result = parseGGUFHeader(buffer);
          destroyStream();
          return result;
        } catch (error) {
          if (error instanceof NeedMoreDataError) {
            // Keep reading
            if (totalRead >= LIMITS.MAX_HEADER_SIZE) {
              throw new ModelLoadFailedError(
                `GGUF header exceeds ${LIMITS.MAX_HEADER_SIZE / (1024 * 1024 * 1024)}GB limit`,
              );
            }
            continue;
          }
          throw error;
        }
      }
    }

    throw new ModelLoadFailedError(
      "File ended before GGUF header could be parsed",
    );
  } finally {
    destroyStream();
  }
}

/**
 * Extract tensor names from all GGUF shards and write to {baseFilename}.tensors.txt
 * Required for sharded models to enable incremental/async loading
 * @throws ModelLoadFailedError if any shard fails extraction
 */
export async function extractAndWriteTensorsFile(
  shardDir: string,
  shardFilenames: string[],
  baseFilename: string,
): Promise<string> {
  const tensorsFilePath = path.join(shardDir, `${baseFilename}.tensors.txt`);

  try {
    await fsPromises.access(tensorsFilePath);
    logger.info(`Tensors file already exists: ${tensorsFilePath}`);
    return tensorsFilePath;
  } catch {
    // Continue with extraction
  }

  logger.info(`Extracting tensors from ${shardFilenames.length} shards...`);

  const allTensorNames = new Set<string>();
  const failedShards: string[] = [];

  for (const filename of shardFilenames) {
    const shardPath = path.join(shardDir, filename);

    try {
      logger.debug(`Extracting tensors from ${filename}...`);
      const tensorNames = await extractTensorNamesFromHeader(shardPath);

      if (tensorNames.length > 0) {
        tensorNames.forEach((name) => allTensorNames.add(name));
        logger.info(`Extracted ${tensorNames.length} tensors from ${filename}`);
      } else {
        failedShards.push(filename);
        logger.error(`No tensors found in ${filename}`);
      }
    } catch (error) {
      failedShards.push(filename);
      logger.error(`Failed to extract tensors from ${filename}:`, error);
    }
  }

  if (failedShards.length > 0) {
    throw new ModelLoadFailedError(
      `Failed to extract tensors from ${failedShards.length}/${shardFilenames.length} shards: ${failedShards.join(", ")}`,
    );
  }

  if (allTensorNames.size === 0) {
    throw new ModelLoadFailedError(
      `Could not extract any tensors from shards.`,
    );
  }

  const tensorNames = Array.from(allTensorNames).sort();
  await fsPromises.writeFile(
    tensorsFilePath,
    tensorNames.join("\n") + "\n",
    "utf8",
  );

  logger.info(
    `Tensors file created: ${tensorsFilePath} (${tensorNames.length} tensors from ${shardFilenames.length} shards)`,
  );

  return tensorsFilePath;
}

/**
 * Check if a file has a valid GGUF header structure.
 * Returns true if the header parses successfully and contains tensor metadata.
 *
 * NOTE: This only validates the header structure, NOT that tensor data exists.
 * A file can have a valid header but be incomplete.
 */
export async function hasValidGGUFHeader(filePath: string): Promise<boolean> {
  try {
    const tensorNames = await extractTensorNamesFromHeader(filePath);
    return tensorNames.length > 0;
  } catch (error) {
    logger.warn(
      `⚠️ GGUF header validation failed: ${error instanceof Error ? error.message : String(error)}`,
    );
    return false;
  }
}
