import fs, { promises as fsPromises } from 'bare-fs'
import path from 'bare-path'
import { createGunzip } from 'bare-zlib'
import tarStream from 'tar-stream'
import Buffer from 'bare-buffer'
import type { AbortSignal } from 'bare-abort-controller'
import {
  detectShardedModel,
  generateShardFilenames,
  checkAllShardsExist
} from '@/utils/shard-utils'
import {
  ModelLoadFailedError,
  ArchiveExtractionFailedError,
  ArchiveUnsupportedTypeError,
  ArchiveMissingShardsError,
  DownloadCancelledError
} from '@/errors/index'
import { isPathWithinBase } from '@/utils/path-security'
import { getEngineLogger } from '@/logging/index'
import {
  SUPPORTED_ARCHIVE_EXTENSIONS,
  filenameToArchiveTypeSchema,
  type ArchiveType
} from '@/schemas/model-file'

const logger = getEngineLogger()

// Gzip magic bytes: 1f 8b 08
const GZIP_MAGIC_0 = 0x1f
const GZIP_MAGIC_1 = 0x8b
const GZIP_MAGIC_2 = 0x08

export function isArchiveUrl(url: string) {
  const filename = url.split('/').pop()?.split('?')[0]?.toLowerCase() || ''
  return SUPPORTED_ARCHIVE_EXTENSIONS.some((ext) => filename.endsWith(ext))
}

// Whitelist of model file extensions to extract from archives
const ALLOWED_MODEL_EXTENSIONS = ['.gguf']

function isModelFile(entryName: string) {
  const basename = path.basename(entryName)

  // Skip resource forks (._filename)
  if (basename.startsWith('._')) {
    return false
  }

  return ALLOWED_MODEL_EXTENSIONS.some((ext) => basename.toLowerCase().endsWith(ext))
}

async function isGzip(archivePath: string) {
  return new Promise<boolean>((resolve, reject) => {
    const stream = fs.createReadStream(archivePath, { start: 0, end: 2 })
    const chunks: Buffer[] = []

    stream.on('data', (chunk) => {
      chunks.push(chunk as Buffer)
    })

    stream.on('end', () => {
      stream.destroy()
      const buffer = Buffer.concat(chunks)

      // Check for gzip magic bytes
      const isGzipped =
        buffer[0] === GZIP_MAGIC_0 && buffer[1] === GZIP_MAGIC_1 && buffer[2] === GZIP_MAGIC_2

      resolve(isGzipped)
    })

    stream.on('error', reject)
  })
}

async function extractArchive(archivePath: string, extractDir: string, signal?: AbortSignal) {
  const parseResult = filenameToArchiveTypeSchema.safeParse(archivePath)
  const extensionType = parseResult.success ? parseResult.data : null
  if (!extensionType) {
    throw new ArchiveUnsupportedTypeError(archivePath)
  }

  if (signal?.aborted) {
    throw new DownloadCancelledError()
  }

  // Detect actual format from magic bytes (extension might be wrong)
  const isGzipped = await isGzip(archivePath)
  const actualType: ArchiveType = isGzipped ? 'tar.gz' : 'tar'

  if (actualType !== extensionType) {
    logger.warn(`⚠️ Archive extension suggests ${extensionType} but content is ${actualType}`)
  }

  await fsPromises.mkdir(extractDir, { recursive: true })

  await extractTarStream(archivePath, extractDir, isGzipped, signal)
}

export async function extractTarStream(
  archivePath: string,
  extractDir: string,
  useGunzip: boolean,
  signal?: AbortSignal
): Promise<void> {
  const extract = tarStream.extract()
  const gunzip = useGunzip ? createGunzip() : null

  return new Promise((resolve, reject) => {
    let settled = false
    let readStream: ReturnType<typeof fs.createReadStream> | null = null
    let writeStream: ReturnType<typeof fs.createWriteStream> | null = null
    let partPath: string | null = null

    // Every failure tears the whole pipeline down and removes the partial file.
    const fail = (error: unknown) => {
      if (settled) return
      settled = true
      signal?.removeEventListener('abort', onAbort)
      readStream?.destroy()
      gunzip?.destroy()
      extract.destroy()
      writeStream?.destroy()
      const done = () => reject(error)
      if (partPath) fsPromises.rm(partPath, { force: true }).then(done, done)
      else done()
    }
    const onAbort = () => fail(new DownloadCancelledError())
    signal?.addEventListener('abort', onAbort)

    extract.on('entry', (header, stream, next) => {
      stream.on('error', fail)

      if (settled) {
        stream.resume()
        return
      }

      if (!isModelFile(header.name)) {
        stream.resume()
        next()
        return
      }

      // Prevent zip-slip: reject entries that escape extractDir (CWE-22)
      const filePath = path.resolve(path.join(extractDir, header.name))

      if (!isPathWithinBase(extractDir, filePath)) {
        logger.warn(`⚠️ Skipping archive entry with path traversal: ${header.name}`)
        stream.resume()
        next()
        return
      }

      if (header.type === 'file') {
        const dir = path.dirname(filePath)
        fs.mkdirSync(dir, { recursive: true })

        // Write under a temporary name so an interrupted extraction never
        // leaves a truncated file under its shard name.
        const entryPartPath = `${filePath}.part`
        partPath = entryPartPath
        writeStream = fs.createWriteStream(entryPartPath)
        stream.pipe(writeStream)

        writeStream.on('finish', () => {
          fsPromises.rename(entryPartPath, filePath).then(() => {
            partPath = null
            writeStream = null
            next()
          }, fail)
        })
        writeStream.on('error', fail)
      } else {
        stream.on('end', next)
        stream.resume()
      }
    })

    extract.on('finish', () => {
      if (settled) return
      settled = true
      signal?.removeEventListener('abort', onAbort)
      resolve()
    })
    extract.on('error', fail)
    gunzip?.on('error', fail)

    readStream = fs.createReadStream(archivePath)
    readStream.on('error', fail)

    // tar-stream's extract is a streamx Writable at runtime; cast past the
    // nominal private brand its shim can't carry (see types/tar-stream).
    const extractDest = extract as unknown as import('bare-stream').Writable
    if (gunzip) {
      // bare-fs and bare-zlib ship distinct stream type declarations even
      // though both expose the same pipe chain at runtime.
      const gzipPipe = readStream as unknown as {
        pipe(destination: typeof gunzip): { pipe(destination: typeof extractDest): unknown }
      }
      gzipPipe.pipe(gunzip).pipe(extractDest)
    } else {
      readStream.pipe(extractDest)
    }
  })
}

// Concurrent loads of one archive share an extract directory, so they share
// one extraction instead of writing the same files at the same time. A joining
// caller shares the first caller's abort signal.
const inFlightExtractions = new Map<string, Promise<string>>()

export function extractAndValidateShardedArchive(
  archivePath: string,
  extractDir: string,
  signal?: AbortSignal
) {
  const inFlight = inFlightExtractions.get(extractDir)
  if (inFlight) return inFlight
  const extraction = extractAndValidateShardedArchiveOnce(archivePath, extractDir, signal).finally(
    () => inFlightExtractions.delete(extractDir)
  )
  inFlightExtractions.set(extractDir, extraction)
  return extraction
}

async function extractAndValidateShardedArchiveOnce(
  archivePath: string,
  extractDir: string,
  signal?: AbortSignal
): Promise<string> {
  // Check if shards already extracted
  try {
    const existingFiles = await fsPromises.readdir(extractDir)
    const existingShard = existingFiles.find((f) => detectShardedModel(String(f)).isSharded)

    if (existingShard) {
      const isComplete = await checkAllShardsExist(extractDir, String(existingShard))

      if (isComplete) {
        logger.info(`✅ Archive already extracted: ${extractDir}`)
        const shardFilenames = generateShardFilenames(String(existingShard))
        return path.join(extractDir, shardFilenames[0]!)
      }

      logger.warn(`⚠️ Incomplete extraction found, re-extracting archive`)
    }
  } catch {
    // Directory doesn't exist, proceed with extraction
  }

  logger.info(`Extracting archive: ${path.basename(archivePath)}`)

  try {
    await extractArchive(archivePath, extractDir, signal)
  } catch (error) {
    throw new ArchiveExtractionFailedError(archivePath, error)
  }

  const files = await fsPromises.readdir(extractDir)
  const shardedFile = files.find((f) => detectShardedModel(String(f)).isSharded)

  if (!shardedFile) {
    throw new ModelLoadFailedError(
      `No sharded model files found in archive. Expected pattern: *-00001-of-0000X.*`
    )
  }

  const shardedFileName = String(shardedFile)
  const shardInfo = detectShardedModel(shardedFileName)

  if (!shardInfo.baseFilename) {
    throw new ModelLoadFailedError(
      `Could not extract base filename from sharded model: ${shardedFileName}`
    )
  }

  const shardFilenames = generateShardFilenames(shardedFileName)
  for (const shardFilename of shardFilenames) {
    const filePath = path.join(extractDir, shardFilename)
    try {
      await fsPromises.access(filePath)
    } catch {
      throw new ArchiveMissingShardsError(shardFilename)
    }
  }

  logger.info(`Archive extracted to ${extractDir} successfully: ${files.length} files`)

  return path.join(extractDir, shardFilenames[0]!)
}
