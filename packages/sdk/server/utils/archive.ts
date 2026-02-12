import { promises as fsPromises } from "bare-fs";
import path from "bare-path";
import fs from "bare-fs";
import { createGunzip } from "bare-zlib";
import tarStream from "tar-stream";
import {
  detectShardedModel,
  generateShardFilenames,
  extractTensorsFromShards,
  validateShardedModelCache,
} from "./shard-utils";
import {
  ModelLoadFailedError,
  ArchiveExtractionFailedError,
  ArchiveUnsupportedTypeError,
  ArchiveMissingShardsError,
  DownloadCancelledError,
} from "@/utils/errors-server";
import { getServerLogger } from "@/logging";
import {
  SUPPORTED_ARCHIVE_EXTENSIONS,
  filenameToArchiveTypeSchema,
  type ArchiveType,
} from "@/schemas/archive";

const logger = getServerLogger();

// Gzip magic bytes: 1f 8b 08
const GZIP_MAGIC_0 = 0x1f;
const GZIP_MAGIC_1 = 0x8b;
const GZIP_MAGIC_2 = 0x08;

export function isArchiveUrl(url: string) {
  const filename = url.split("/").pop()?.split("?")[0]?.toLowerCase() || "";
  return SUPPORTED_ARCHIVE_EXTENSIONS.some((ext) => filename.endsWith(ext));
}

// Whitelist of model file extensions to extract from archives
const ALLOWED_MODEL_EXTENSIONS = [".gguf", ".tensors.txt"];

function isModelFile(entryName: string) {
  const basename = path.basename(entryName);

  // Skip resource forks (._filename)
  if (basename.startsWith("._")) {
    return false;
  }

  return ALLOWED_MODEL_EXTENSIONS.some((ext) =>
    basename.toLowerCase().endsWith(ext),
  );
}

async function isGzip(archivePath: string) {
  return new Promise<boolean>((resolve, reject) => {
    const stream = fs.createReadStream(archivePath, { start: 0, end: 2 });
    const chunks: Buffer[] = [];

    stream.on("data", (chunk: Buffer) => {
      chunks.push(chunk);
    });

    stream.on("end", () => {
      stream.destroy();
      const buffer = Buffer.concat(chunks);

      // Check for gzip magic bytes
      const isGzipped =
        buffer[0] === GZIP_MAGIC_0 &&
        buffer[1] === GZIP_MAGIC_1 &&
        buffer[2] === GZIP_MAGIC_2;

      resolve(isGzipped);
    });

    stream.on("error", reject);
  });
}

async function extractArchive(
  archivePath: string,
  extractDir: string,
  signal?: AbortSignal,
) {
  const parseResult = filenameToArchiveTypeSchema.safeParse(archivePath);
  const extensionType = parseResult.success ? parseResult.data : null;
  if (!extensionType) {
    throw new ArchiveUnsupportedTypeError(archivePath);
  }

  if (signal?.aborted) {
    throw new DownloadCancelledError();
  }

  // Detect actual format from magic bytes (extension might be wrong)
  const isGzipped = await isGzip(archivePath);
  const actualType: ArchiveType = isGzipped ? "tar.gz" : "tar";

  if (actualType !== extensionType) {
    logger.warn(
      `⚠️ Archive extension suggests ${extensionType} but content is ${actualType}`,
    );
  }

  await fsPromises.mkdir(extractDir, { recursive: true });

  await extractTarStream(archivePath, extractDir, isGzipped, signal);
}

async function extractTarStream(
  archivePath: string,
  extractDir: string,
  useGunzip: boolean,
  signal?: AbortSignal,
): Promise<void> {
  const extract = tarStream.extract();
  const gunzip = useGunzip ? createGunzip() : null;

  return new Promise((resolve, reject) => {
    let aborted = false;
    let readStream: ReturnType<typeof fs.createReadStream> | null = null;

    const cleanup = () => {
      aborted = true;
      readStream?.destroy();
      gunzip?.destroy();
      extract.destroy();
    };

    if (signal) {
      signal.addEventListener("abort", () => {
        cleanup();
        reject(new DownloadCancelledError());
      });
    }

    extract.on("entry", (header, stream, next) => {
      if (aborted) {
        stream.resume();
        return;
      }

      if (!isModelFile(header.name)) {
        stream.resume();
        next();
        return;
      }

      const filePath = path.join(extractDir, header.name);

      if (header.type === "file") {
        const dir = path.dirname(filePath);
        fs.mkdirSync(dir, { recursive: true });

        const writeStream = fs.createWriteStream(filePath);
        stream.pipe(writeStream);

        writeStream.on("finish", next);
        writeStream.on("error", reject);
      } else {
        stream.on("end", next);
        stream.resume();
      }
    });

    extract.on("finish", resolve);
    extract.on("error", reject);

    if (gunzip) {
      gunzip.on("error", reject);
    }

    readStream = fs.createReadStream(archivePath);

    if (gunzip) {
      readStream.pipe(gunzip).pipe(extract);
    } else {
      readStream.pipe(extract);
    }
  });
}

export async function extractAndValidateShardedArchive(
  archivePath: string,
  extractDir: string,
  signal?: AbortSignal,
): Promise<string> {
  // Check if shards already extracted
  try {
    const existingFiles = await fsPromises.readdir(extractDir);
    const existingShard = existingFiles.find(
      (f) => detectShardedModel(String(f)).isSharded,
    );

    if (existingShard) {
      const isComplete = await validateShardedModelCache(
        extractDir,
        String(existingShard),
      );

      if (isComplete) {
        logger.info(`✅ Archive already extracted: ${extractDir}`);
        const shardFilenames = generateShardFilenames(String(existingShard));
        return path.join(extractDir, shardFilenames[0]!);
      }

      logger.warn(`⚠️ Incomplete extraction found, re-extracting archive`);
    }
  } catch {
    // Directory doesn't exist, proceed with extraction
  }

  logger.info(`Extracting archive: ${path.basename(archivePath)}`);

  try {
    await extractArchive(archivePath, extractDir, signal);
  } catch (error) {
    throw new ArchiveExtractionFailedError(archivePath, error);
  }

  const files = await fsPromises.readdir(extractDir);
  const shardedFile = files.find(
    (f) => detectShardedModel(String(f)).isSharded,
  );

  if (!shardedFile) {
    throw new ModelLoadFailedError(
      `No sharded model files found in archive. Expected pattern: *-00001-of-0000X.*`,
    );
  }

  const shardedFileName = String(shardedFile);
  const shardInfo = detectShardedModel(shardedFileName);

  if (!shardInfo.baseFilename) {
    throw new ModelLoadFailedError(
      `Could not extract base filename from sharded model: ${shardedFileName}`,
    );
  }

  const shardFilenames = generateShardFilenames(shardedFileName);
  for (const shardFilename of shardFilenames) {
    const filePath = path.join(extractDir, shardFilename);
    try {
      await fsPromises.access(filePath);
    } catch {
      throw new ArchiveMissingShardsError(shardFilename);
    }
  }

  // Generate tensors.txt if it doesn't exist
  await extractTensorsFromShards(extractDir, shardedFileName);

  logger.info(
    `Archive extracted to ${extractDir} successfully: ${files.length} files`,
  );

  return path.join(extractDir, shardFilenames[0]!);
}
