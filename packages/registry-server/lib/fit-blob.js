'use strict'

const fs = require('fs')
const fsPromises = fs.promises
const path = require('path')
const crypto = require('crypto')
const { gguf, buildGgufHeader, GGUFValueType } = require('@huggingface/gguf')
const logger = require('./logger')

const SAFETENSORS_LENGTH_PREFIX_BYTES = 8
const SAFETENSORS_MAX_HEADER_BYTES = 64 * 1024 * 1024
const GGUF_DEFAULT_ALIGNMENT = 32
const FIT_BLOB_SUFFIX = '.fit'

const TOKENIZER_KEY_MARKER = 'tokenizer.'
const TOKENIZER_MODEL_KEY = 'tokenizer.ggml.model'
const TOKEN_TYPE_COUNT_KEY = 'tokenizer.ggml.token_type_count'
const VOCAB_LESS_TOKENIZER_MODEL = 'none'
const VOCAB_TENSOR_NAMES = ['token_embd.weight', 'output.weight']

// Per-tensor manifests the tensor list already carries. Written by the
// supertonic converter and read only by its offline requantizer, so nothing
// loading the file needs them.
const TENSOR_MANIFEST_KEYS = new Set([
  'supertonic.tensor_names',
  'supertonic.source_names',
  'supertonic.tensor_shapes',
  'supertonic.tensor_dtypes',
  'supertonic.tensor_sha256',
  'supertonic.source_aliases',
  'supertonic.source_alias_targets'
])

function isGGUFFile(filePath) {
  return filePath.toLowerCase().endsWith('.gguf')
}

function isSafetensorsFile(filePath) {
  return filePath.toLowerCase().endsWith('.safetensors')
}

function supportsFitBlob(filePath) {
  return isGGUFFile(filePath) || isSafetensorsFile(filePath)
}

/**
 * Number of tokens the model was trained with, from `{arch}.vocab_size` or,
 * where that key is absent, the second dimension of the token embedding.
 * Returns `null` when neither is available.
 */
function resolveVocabSize(parsed, architecture) {
  const declared = parsed.metadata[`${architecture}.vocab_size`]
  if (typeof declared === 'number' && declared > 0) {
    return declared
  }

  for (const name of VOCAB_TENSOR_NAMES) {
    const tensor = parsed.tensorInfos.find((info) => info.name === name)
    if (!tensor || tensor.shape.length < 2) continue

    const size = Number(tensor.shape[1])
    if (Number.isSafeInteger(size) && size > 0) return size
  }

  return null
}

function withoutTokenizerTables(parsed) {
  const architecture = parsed.metadata['general.architecture']
  const vocabSize = typeof architecture === 'string' ? resolveVocabSize(parsed, architecture) : null
  const metadata = {}

  for (const [key, entry] of Object.entries(parsed.typedMetadata)) {
    if (key.includes(TOKENIZER_KEY_MARKER) && key !== TOKEN_TYPE_COUNT_KEY) continue
    if (TENSOR_MANIFEST_KEYS.has(key)) continue
    metadata[key] = entry
  }

  // Absent, the loader has no vocabulary implementation to pick and refuses the
  // file. `none` takes the branch that reads no tables.
  metadata[TOKENIZER_MODEL_KEY] = {
    value: VOCAB_LESS_TOKENIZER_MODEL,
    type: GGUFValueType.STRING
  }

  // The output buffer is as wide as the vocabulary, so a missing count would
  // under-project it. Omitted rather than guessed when nothing declares it.
  if (vocabSize !== null) {
    metadata[`${architecture}.vocab_size`] = {
      value: vocabSize,
      type: GGUFValueType.UINT32
    }
  }

  return metadata
}

async function ggufFitBlob(filePath) {
  const parsed = await gguf(filePath, { allowLocalFile: true, typedMetadata: true })
  if (!parsed.tensorInfoByteRange) return null

  // A truncated file still parses far enough to yield a byte range, and would
  // otherwise be rewritten into a well-formed blob describing nothing.
  const { size } = await fsPromises.stat(filePath)
  const dataOffset = Number(parsed.tensorDataOffset)
  if (!Number.isSafeInteger(dataOffset) || dataOffset <= 0 || dataOffset > size) return null
  if (parsed.tensorInfos.length !== Number(parsed.metadata.tensor_count)) return null

  const alignment = parsed.metadata['general.alignment']
  const source = await fs.openAsBlob(filePath)
  const built = await buildGgufHeader(source, withoutTokenizerTables(parsed), {
    littleEndian: parsed.littleEndian,
    tensorInfoByteRange: parsed.tensorInfoByteRange,
    alignment: typeof alignment === 'number' ? alignment : GGUF_DEFAULT_ALIGNMENT
  })

  return Buffer.from(await built.arrayBuffer())
}

async function safetensorsFitBlob(filePath) {
  const handle = await fsPromises.open(filePath, 'r')
  try {
    const prefix = Buffer.allocUnsafe(SAFETENSORS_LENGTH_PREFIX_BYTES)
    const { bytesRead } = await handle.read(prefix, 0, SAFETENSORS_LENGTH_PREFIX_BYTES, 0)
    if (bytesRead < SAFETENSORS_LENGTH_PREFIX_BYTES) return null

    const headerBytes = prefix.readBigUInt64LE(0)
    if (headerBytes <= 0n || headerBytes > BigInt(SAFETENSORS_MAX_HEADER_BYTES)) return null

    const length = SAFETENSORS_LENGTH_PREFIX_BYTES + Number(headerBytes)
    const { size } = await handle.stat()
    if (length > size) return null

    const header = Buffer.allocUnsafe(length)
    const read = await handle.read(header, 0, length, 0)
    return read.bytesRead === length ? header : null
  } finally {
    await handle.close()
  }
}

function fitBlobContent(filePath) {
  if (isGGUFFile(filePath)) return ggufFitBlob(filePath)
  if (isSafetensorsFile(filePath)) return safetensorsFitBlob(filePath)
  return null
}

/**
 * Writes the weightless description of an artifact next to it: a GGUF holding
 * the tensor inventory and the settings with the tokenizer tables left out, or
 * a safetensors' JSON header.
 *
 * Returns `{ path, size, sha256 }`, or `null` when the format carries no
 * separable description or the artifact could not be read.
 */
async function writeFitBlob(filePath, outputDir) {
  if (!supportsFitBlob(filePath)) return null

  try {
    const content = await fitBlobContent(filePath)
    if (!content || content.length === 0) {
      logger.warn('No description could be built for fit blob', { filePath })
      return null
    }

    const { size } = await fsPromises.stat(filePath)
    const outputPath = path.join(outputDir, path.basename(filePath) + FIT_BLOB_SUFFIX)
    await fsPromises.writeFile(outputPath, content)

    logger.info('Fit blob written', {
      filePath,
      size: content.length,
      share: ((content.length / size) * 100).toFixed(2) + '%'
    })

    return {
      path: outputPath,
      size: content.length,
      sha256: crypto.createHash('sha256').update(content).digest('hex')
    }
  } catch (err) {
    logger.warn('Failed to write fit blob', { filePath, error: err.message })
    return null
  }
}

module.exports = {
  supportsFitBlob,
  fitBlobContent,
  writeFitBlob,
  FIT_BLOB_SUFFIX
}
