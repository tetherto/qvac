'use strict'

const { FormatError } = require('./file-cursor')
const { DescriptionWriter } = require('./gguf-writer')
const {
  expectGgmlMagic,
  readInt32Fields,
  readCount,
  readTensorsToEnd,
  writeTensors
} = require('./ggml-bin')
const { readTokenLengths, lengthHistogram } = require('./token-lengths')
const { summarizeSentencePiece, writeSentencePieceSummary } = require('./sentencepiece')

const NMT_ARCHITECTURE = 'nmt'
const NMT_MODEL_TYPE_INDICTRANS = 1

const NMT_HPARAMS = [
  'n_vocab',
  'n_encoder_ctx',
  'd_model',
  'n_encoder_heads',
  'n_encoder_layers',
  'n_decoder_ctx',
  'n_text_state',
  'n_decoder_heads',
  'n_decoder_layers'
]
const INDICTRANS_HPARAMS = [
  'n_tgt_vocab',
  'encoder_normalize_before',
  'decoder_normalize_before',
  'layernorm_embedding',
  'scale_embedding',
  'has_lm_head',
  'encoder_ffn_dim',
  'decoder_ffn_dim'
]

const NMT_MAX_VOCAB_SIZE = 1000000
const NMT_MAX_VOCAB_TOKEN_LENGTH = 1024
const NMT_MAX_SENTENCEPIECE_MODEL_BYTES = 64 * 1024 * 1024
const SOURCE_TOKEN_PREFIX_BYTES = 0
const TARGET_TOKEN_PREFIX_BYTES = 4

async function readModelType(cursor) {
  const modelType = await cursor.i32()
  if (modelType !== NMT_MODEL_TYPE_INDICTRANS) {
    throw new FormatError(`nmt model type ${modelType} is not IndicTrans`)
  }
  return modelType
}

async function readEmbeddedSentencePiece(cursor) {
  const bytes = await cursor.i32()
  if (bytes <= 0) return { bytes: 0, summary: null }
  if (bytes > NMT_MAX_SENTENCEPIECE_MODEL_BYTES) {
    throw new FormatError(`embedded SentencePiece model of ${bytes} bytes`)
  }
  const summary = summarizeSentencePiece(Buffer.from(await cursor.bytes(bytes)))
  return { bytes, summary }
}

async function readVocab(cursor, prefixBytes) {
  const count = await readCount(cursor, NMT_MAX_VOCAB_SIZE, 'vocab')
  return readTokenLengths(cursor, count, NMT_MAX_VOCAB_TOKEN_LENGTH, prefixBytes)
}

function writeInt32Fields(writer, fields) {
  for (const [name, value] of Object.entries(fields)) {
    writer.i32(`${NMT_ARCHITECTURE}.${name}`, value)
  }
}

function writeVocab(writer, name, tokenLengths) {
  writer.i32(`${NMT_ARCHITECTURE}.${name}.n_tokens`, tokenLengths.length)
  writer.u32Array(`${NMT_ARCHITECTURE}.${name}.token_length_counts`, lengthHistogram(tokenLengths))
}

function writeEmbeddedSentencePiece(writer, name, sentencePiece) {
  const prefix = `${NMT_ARCHITECTURE}.${name}`
  writer.u64(`${prefix}.bytes`, sentencePiece.bytes)
  if (sentencePiece.summary) writeSentencePieceSummary(writer, prefix, sentencePiece.summary)
}

function writeNmtDescription(sourceSize, model) {
  const writer = new DescriptionWriter(NMT_ARCHITECTURE, sourceSize)
  writeInt32Fields(writer, model.hparams)
  writer.i32('nmt.model_type', model.modelType)
  writer.i32('nmt.ftype', model.ftype)
  writeInt32Fields(writer, model.indicTrans)
  writeVocab(writer, 'src_vocab', model.sourceTokenLengths)
  writeEmbeddedSentencePiece(writer, 'src_spm', model.sourceSentencePiece)
  writeEmbeddedSentencePiece(writer, 'tgt_spm', model.targetSentencePiece)
  writeVocab(writer, 'tgt_vocab', model.targetTokenLengths)
  writeTensors(writer, model.tensors)
  return writer.toBuffer()
}

async function describeIndicTrans(cursor) {
  await expectGgmlMagic(cursor)
  const hparams = await readInt32Fields(cursor, NMT_HPARAMS)
  const modelType = await readModelType(cursor)
  const ftype = await cursor.i32()
  const indicTrans = await readInt32Fields(cursor, INDICTRANS_HPARAMS)
  const sourceTokenLengths = await readVocab(cursor, SOURCE_TOKEN_PREFIX_BYTES)
  const sourceSentencePiece = await readEmbeddedSentencePiece(cursor)
  const targetSentencePiece = await readEmbeddedSentencePiece(cursor)
  const targetTokenLengths = await readVocab(cursor, TARGET_TOKEN_PREFIX_BYTES)
  const tensors = await readTensorsToEnd(cursor)
  return writeNmtDescription(cursor.size, {
    hparams,
    modelType,
    ftype,
    indicTrans,
    sourceTokenLengths,
    sourceSentencePiece,
    targetSentencePiece,
    targetTokenLengths,
    tensors
  })
}

module.exports = { describeIndicTrans }
