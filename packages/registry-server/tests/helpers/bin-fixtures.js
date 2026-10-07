'use strict'

const GGML_FILE_MAGIC = 0x67676d6c
const BCI_EMBEDDER_MAGIC = 0x42434945
const MARIAN_BINARY_FILE_VERSION = 1
const MARIAN_CONFIG_ITEM = 'special:model.yml'
const MARIAN_DATA_ALIGNMENT = 256
const BINARY_SHORTLIST_MAGIC = 0xf11a48d5013417f5n
const INDICTRANS_MODEL_TYPE = 1

const GGML_TYPE_F32 = 0
const GGML_TYPE_F16 = 1
const GGML_TYPE_Q8_0 = 8

const WIRE_VARINT = 0
const WIRE_LENGTH_DELIMITED = 2
const WIRE_FIXED32 = 5

const DEFAULT_TOKENS = ['', 'a', 'bc', 'def', 'ghij', ' the']

function i32(value) {
  const buffer = Buffer.allocUnsafe(4)
  buffer.writeInt32LE(value)
  return buffer
}

function u32(value) {
  const buffer = Buffer.allocUnsafe(4)
  buffer.writeUInt32LE(value)
  return buffer
}

function u64(value) {
  const buffer = Buffer.allocUnsafe(8)
  buffer.writeBigUInt64LE(BigInt(value))
  return buffer
}

function i32s(values) {
  return Buffer.concat(values.map(i32))
}

function lengthPrefixed(text) {
  const bytes = Buffer.from(text, 'utf8')
  return Buffer.concat([u32(bytes.length), bytes])
}

function payloadBytes(type, ne) {
  const elements = ne.reduce((total, value) => total * value, 1)
  if (type === GGML_TYPE_F32) return elements * 4
  if (type === GGML_TYPE_F16) return elements * 2
  if (type === GGML_TYPE_Q8_0) return (elements / 32) * 34
  throw new Error(`fixture type ${type} has no payload size`)
}

function ggmlTensor({ name, type, ne }) {
  const nameBytes = Buffer.from(name, 'utf8')
  return Buffer.concat([
    i32s([ne.length, nameBytes.length, type, ...ne]),
    nameBytes,
    Buffer.alloc(payloadBytes(type, ne), 7)
  ])
}

const DEFAULT_WHISPER_TENSORS = [
  { name: 'encoder.positional_embedding', type: GGML_TYPE_F32, ne: [4, 3] },
  { name: 'encoder.conv1.weight', type: GGML_TYPE_F16, ne: [3, 2, 4] },
  { name: 'decoder.token_embedding.weight', type: GGML_TYPE_Q8_0, ne: [32, 6] },
  { name: 'decoder.ln.bias', type: GGML_TYPE_F32, ne: [] }
]

function buildWhisperBin({
  nVocab = 51865,
  nMels = 80,
  bci = null,
  melFilters = { nMel: 2, nFft: 3 },
  tokens = DEFAULT_TOKENS,
  tensors = DEFAULT_WHISPER_TENSORS
} = {}) {
  const hparams = [nVocab, 1500, 384, 6, 4, 448, 384, 6, 4, nMels, 1]
  return Buffer.concat([
    u32(GGML_FILE_MAGIC),
    i32s(hparams),
    bci ? i32s(bci) : Buffer.alloc(0),
    i32s([melFilters.nMel, melFilters.nFft]),
    Buffer.alloc(melFilters.nMel * melFilters.nFft * 4, 1),
    i32(tokens.length),
    ...tokens.map(lengthPrefixed),
    ...tensors.map(ggmlTensor)
  ])
}

function buildWhisperVadBin({ modelType = 'silero-16k', tensors = DEFAULT_WHISPER_TENSORS } = {}) {
  const typeBytes = Buffer.from(modelType, 'utf8')
  return Buffer.concat([
    u32(GGML_FILE_MAGIC),
    i32(typeBytes.length),
    typeBytes,
    i32s([5, 1, 2, 512, 64]),
    i32s([2, 129, 128, 3, 128, 64, 3]),
    i32s([128, 128, 128, 1]),
    ...tensors.map(ggmlTensor)
  ])
}

function floatArray(count) {
  return Buffer.concat([u32(count), Buffer.alloc(count * 4, 2)])
}

function buildBciEmbedder({
  numFeatures = 4,
  rank = 2,
  numDays = 2,
  numMonths = 1,
  sessions = 3
} = {}) {
  const days = Array.from({ length: numDays }, () =>
    Buffer.concat([
      floatArray(numFeatures * rank),
      floatArray(rank * numFeatures),
      floatArray(numFeatures)
    ])
  )
  const months = Array.from({ length: numMonths }, () =>
    Buffer.concat([floatArray(numFeatures * numFeatures), floatArray(numFeatures)])
  )
  return Buffer.concat([
    u32(BCI_EMBEDDER_MAGIC),
    u32(1),
    Buffer.concat([numFeatures, 8, 7, 3, 2, numDays, numMonths, rank].map(u32)),
    floatArray(6),
    floatArray(8),
    floatArray(5),
    floatArray(8),
    u32(sessions),
    Buffer.alloc(sessions * 4),
    ...days,
    ...months
  ])
}

function varint(value) {
  const bytes = []
  let rest = value
  while (rest >= 0x80) {
    bytes.push((rest % 0x80) | 0x80)
    rest = Math.floor(rest / 0x80)
  }
  bytes.push(rest)
  return Buffer.from(bytes)
}

function protoField(number, wireType, payload) {
  return Buffer.concat([varint(number * 8 + wireType), payload])
}

function protoBytes(number, bytes) {
  return protoField(number, WIRE_LENGTH_DELIMITED, Buffer.concat([varint(bytes.length), bytes]))
}

function sentencePieceEntry(piece) {
  const score = Buffer.allocUnsafe(4)
  score.writeFloatLE(-1.5)
  return Buffer.concat([
    protoBytes(1, Buffer.from(piece, 'utf8')),
    protoField(2, WIRE_FIXED32, score),
    protoField(3, WIRE_VARINT, varint(1))
  ])
}

function buildSentencePiece({
  pieces = ['<unk>', '<s>', '</s>', 'a', 'bc', 'bc'],
  modelType = 2,
  charsmapBytes = 24
} = {}) {
  return Buffer.concat([
    ...pieces.map((piece) => protoBytes(1, sentencePieceEntry(piece))),
    protoBytes(2, Buffer.concat([protoField(3, WIRE_VARINT, varint(modelType))])),
    protoBytes(
      3,
      Buffer.concat([
        protoBytes(1, Buffer.from('nmt_nfkc')),
        protoBytes(2, Buffer.alloc(charsmapBytes, 9))
      ])
    )
  ])
}

function embeddedSentencePiece(proto) {
  return proto ? Buffer.concat([i32(proto.length), proto]) : i32(0)
}

const DEFAULT_INDICTRANS_TENSORS = [
  { name: 'model.encoder.embed_tokens.weight', type: GGML_TYPE_F16, ne: [8, 6] },
  { name: 'model.decoder.layer_norm.weight', type: GGML_TYPE_F32, ne: [8] }
]

function buildIndicTransBin({
  modelType = INDICTRANS_MODEL_TYPE,
  sourceTokens = DEFAULT_TOKENS,
  targetTokens = ['x', 'yz'],
  sourceSentencePiece = buildSentencePiece(),
  targetSentencePiece = buildSentencePiece({ pieces: ['<unk>', 'q'] }),
  tensors = DEFAULT_INDICTRANS_TENSORS
} = {}) {
  return Buffer.concat([
    u32(GGML_FILE_MAGIC),
    i32s([6, 256, 8, 2, 1, 256, 8, 2, 1]),
    i32(modelType),
    i32(1),
    i32s([4, 1, 1, 1, 1, 0, 16, 16]),
    i32(sourceTokens.length),
    ...sourceTokens.map(lengthPrefixed),
    embeddedSentencePiece(sourceSentencePiece),
    embeddedSentencePiece(targetSentencePiece),
    i32(targetTokens.length),
    ...targetTokens.map((token, id) => Buffer.concat([i32(id), lengthPrefixed(token)])),
    ...tensors.map(ggmlTensor)
  ])
}

const DEFAULT_MARIAN_ITEMS = [
  { name: 'Wemb', type: 0x4101, shape: [8, 4], data: Buffer.alloc(36, 1) },
  { name: 'decoder_ff_logit_out_b', type: 0x404, shape: [1, 8], data: Buffer.alloc(32, 2) }
]

function buildMarianModel({
  config = 'dim-emb: 4\nenc-depth: 1\n',
  items = DEFAULT_MARIAN_ITEMS
} = {}) {
  const all = [
    ...items,
    { name: MARIAN_CONFIG_ITEM, type: 0x101, shape: [1], data: Buffer.from(config + '\0') }
  ]
  const head = Buffer.concat([
    u64(MARIAN_BINARY_FILE_VERSION),
    u64(all.length),
    ...all.map((item) =>
      Buffer.concat([
        u64(item.name.length + 1),
        u64(item.type),
        u64(item.shape.length),
        u64(item.data.length)
      ])
    ),
    ...all.map((item) => Buffer.from(item.name + '\0')),
    ...all.map((item) => i32s(item.shape))
  ])
  const nextPosition =
    (Math.floor((head.length + 8) / MARIAN_DATA_ALIGNMENT) + 1) * MARIAN_DATA_ALIGNMENT
  const padding = nextPosition - head.length - 8
  return Buffer.concat([head, u64(padding), Buffer.alloc(padding), ...all.map((item) => item.data)])
}

function buildMarianShortlist({
  firstNum = 50,
  bestNum = 50,
  wordToOffset = [0, 2, 3],
  shortLists = [1, 2, 0]
} = {}) {
  const magic = Buffer.allocUnsafe(8)
  magic.writeBigUInt64LE(BINARY_SHORTLIST_MAGIC)
  return Buffer.concat([
    magic,
    u64(0),
    u64(firstNum),
    u64(bestNum),
    u64(wordToOffset.length),
    u64(shortLists.length),
    ...wordToOffset.map(u64),
    ...shortLists.map(u32)
  ])
}

module.exports = {
  GGML_TYPE_F32,
  GGML_TYPE_F16,
  GGML_TYPE_Q8_0,
  DEFAULT_TOKENS,
  DEFAULT_WHISPER_TENSORS,
  DEFAULT_INDICTRANS_TENSORS,
  DEFAULT_MARIAN_ITEMS,
  buildWhisperBin,
  buildWhisperVadBin,
  buildBciEmbedder,
  buildSentencePiece,
  buildIndicTransBin,
  buildMarianModel,
  buildMarianShortlist
}
