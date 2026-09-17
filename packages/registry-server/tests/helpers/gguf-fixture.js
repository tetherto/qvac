'use strict'

const GGUF_ALIGNMENT = 32
const GGUF_VALUE_TYPE_UINT32 = 4
const GGUF_VALUE_TYPE_FLOAT32 = 6
const GGUF_VALUE_TYPE_STRING = 8
const GGUF_VALUE_TYPE_ARRAY = 9
const GGML_TYPE_F32 = 0

function ggufString(value) {
  const bytes = Buffer.from(value, 'utf8')
  const length = Buffer.allocUnsafe(8)
  length.writeBigUInt64LE(BigInt(bytes.length))
  return Buffer.concat([length, bytes])
}

function u32(value) {
  const buf = Buffer.allocUnsafe(4)
  buf.writeUInt32LE(value)
  return buf
}

function f32(value) {
  const buf = Buffer.allocUnsafe(4)
  buf.writeFloatLE(value)
  return buf
}

function u64(value) {
  const buf = Buffer.allocUnsafe(8)
  buf.writeBigUInt64LE(BigInt(value))
  return buf
}

function kv(key, type, value) {
  return Buffer.concat([ggufString(key), u32(type), value])
}

function array(subType, entries) {
  return Buffer.concat([u32(subType), u64(entries.length), ...entries])
}

/**
 * Builds a GGUF whose tensor data is filler. `vocabSize` tokens are written as
 * real tokenizer tables, and the token embedding is shaped
 * `[embeddingLength, vocabSize]` so a fit blob can recover the count without
 * the `vocab_size` key.
 */
function buildGguf({
  tensorCount = 1,
  dataBytes = 64,
  architecture = 'llama',
  vocabSize = 8,
  embeddingLength = 4,
  declareVocabSize = false,
  tokenTypeCount = null,
  tokenizerModel = 'gpt2',
  architectureTokenizer = false,
  tensorManifest = false
} = {}) {
  const tokens = []
  const scores = []
  for (let i = 0; i < vocabSize; i++) {
    tokens.push(ggufString(`tok${i}`))
    scores.push(f32(i))
  }

  const entries = []
  if (architecture !== null) {
    entries.push(
      kv('general.architecture', GGUF_VALUE_TYPE_STRING, ggufString(architecture)),
      kv(`${architecture}.embedding_length`, GGUF_VALUE_TYPE_UINT32, u32(embeddingLength))
    )
  }
  entries.push(
    kv('tokenizer.ggml.model', GGUF_VALUE_TYPE_STRING, ggufString(tokenizerModel)),
    kv('tokenizer.ggml.tokens', GGUF_VALUE_TYPE_ARRAY, array(GGUF_VALUE_TYPE_STRING, tokens)),
    kv('tokenizer.ggml.scores', GGUF_VALUE_TYPE_ARRAY, array(GGUF_VALUE_TYPE_FLOAT32, scores)),
    kv('tokenizer.ggml.merges', GGUF_VALUE_TYPE_ARRAY, array(GGUF_VALUE_TYPE_STRING, tokens))
  )

  if (architectureTokenizer) {
    entries.push(
      kv(
        `${architecture}.prompt_tokenizer.tokens`,
        GGUF_VALUE_TYPE_ARRAY,
        array(GGUF_VALUE_TYPE_STRING, tokens)
      ),
      kv(
        `${architecture}.prompt_tokenizer.merges`,
        GGUF_VALUE_TYPE_ARRAY,
        array(GGUF_VALUE_TYPE_STRING, tokens)
      )
    )
  }

  if (tensorManifest) {
    const names = Array.from({ length: tensorCount }, (_, i) => ggufString(`tensor.${i}`))
    entries.push(
      kv('supertonic.tensor_names', GGUF_VALUE_TYPE_ARRAY, array(GGUF_VALUE_TYPE_STRING, names)),
      kv('supertonic.tensor_sha256', GGUF_VALUE_TYPE_ARRAY, array(GGUF_VALUE_TYPE_STRING, names))
    )
  }

  if (declareVocabSize) {
    entries.push(kv(`${architecture}.vocab_size`, GGUF_VALUE_TYPE_UINT32, u32(vocabSize)))
  }
  if (tokenTypeCount !== null) {
    entries.push(kv('tokenizer.ggml.token_type_count', GGUF_VALUE_TYPE_UINT32, u32(tokenTypeCount)))
  }

  const head = Buffer.concat([
    Buffer.from('GGUF', 'ascii'),
    u32(3),
    u64(tensorCount + 1),
    u64(entries.length),
    ...entries
  ])

  const tensors = [
    Buffer.concat([
      ggufString('token_embd.weight'),
      u32(2),
      u64(embeddingLength),
      u64(vocabSize),
      u32(GGML_TYPE_F32),
      u64(0)
    ])
  ]
  for (let i = 0; i < tensorCount; i++) {
    tensors.push(
      Buffer.concat([ggufString(`tensor.${i}`), u32(1), u64(4), u32(GGML_TYPE_F32), u64(i * 16)])
    )
  }

  const header = Buffer.concat([head, ...tensors])
  const padding = (GGUF_ALIGNMENT - (header.length % GGUF_ALIGNMENT)) % GGUF_ALIGNMENT

  return {
    buffer: Buffer.concat([header, Buffer.alloc(padding), Buffer.alloc(dataBytes, 7)]),
    metadataLength: header.length + padding,
    vocabSize,
    embeddingLength,
    tensorNames: [
      'token_embd.weight',
      ...Array.from({ length: tensorCount }, (_, i) => `tensor.${i}`)
    ]
  }
}

function buildSafetensors() {
  const header = Buffer.from(
    JSON.stringify({ 'tensor.0': { dtype: 'F32', shape: [4], data_offsets: [0, 16] } }),
    'utf8'
  )

  return {
    buffer: Buffer.concat([u64(header.length), header, Buffer.alloc(16, 7)]),
    metadataLength: 8 + header.length
  }
}

module.exports = {
  buildGguf,
  buildSafetensors,
  u64
}
