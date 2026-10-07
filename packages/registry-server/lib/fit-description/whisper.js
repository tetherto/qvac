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

const WHISPER_ARCHITECTURE = 'whisper'
const WHISPER_VAD_ARCHITECTURE = 'whisper_vad'

const WHISPER_HPARAMS = [
  'n_vocab',
  'n_audio_ctx',
  'n_audio_state',
  'n_audio_head',
  'n_audio_layer',
  'n_text_ctx',
  'n_text_state',
  'n_text_head',
  'n_text_layer',
  'n_mels',
  'ftype'
]
const BCI_HPARAMS = ['n_audio_conv1_kernel', 'n_audio_window_size', 'n_audio_last_window_layer']
const BCI_MEL_THRESHOLD = 256

const FLOAT_BYTES = 4
const MAX_MEL_FILTER_DIM = 4096
const MAX_VOCAB_TOKENS = 1 << 20
const MAX_TOKEN_BYTES = 1 << 16

const VAD_VERSION_FIELDS = 3
const VAD_ENCODER_LAYER_FIELDS = ['in_channels', 'out_channels', 'kernel_size']
const VAD_TAIL_FIELDS = ['lstm_input_size', 'lstm_hidden_size', 'final_conv_in', 'final_conv_out']
const MAX_VAD_MODEL_TYPE_BYTES = 64
const VAD_ENCODER_LAYERS = 4

function isBciHeader(hparams) {
  return hparams.n_mels > BCI_MEL_THRESHOLD
}

async function readMelFilters(cursor) {
  const nMel = await cursor.i32()
  const nFft = await cursor.i32()
  if (nMel < 0 || nMel > MAX_MEL_FILTER_DIM || nFft < 0 || nFft > MAX_MEL_FILTER_DIM) {
    throw new FormatError(`mel filters of ${nMel}x${nFft}`)
  }
  cursor.skip(nMel * nFft * FLOAT_BYTES)
  return { nMel, nFft }
}

async function readWhisperVocab(cursor) {
  const count = await readCount(cursor, MAX_VOCAB_TOKENS, 'vocab')
  return readTokenLengths(cursor, count, MAX_TOKEN_BYTES)
}

function writeInt32Fields(writer, prefix, fields) {
  for (const [name, value] of Object.entries(fields)) writer.i32(`${prefix}.${name}`, value)
}

function writeWhisperDescription(sourceSize, { hparams, bci, melFilters, tokenLengths, tensors }) {
  const writer = new DescriptionWriter(WHISPER_ARCHITECTURE, sourceSize)
  writeInt32Fields(writer, WHISPER_ARCHITECTURE, hparams)
  if (bci) writeInt32Fields(writer, WHISPER_ARCHITECTURE, bci)
  writer.i32('whisper.mel_filters.n_mel', melFilters.nMel)
  writer.i32('whisper.mel_filters.n_fft', melFilters.nFft)
  writer.i32('whisper.vocab.n_tokens', tokenLengths.length)
  writer.u32Array('whisper.vocab.token_length_counts', lengthHistogram(tokenLengths))
  writeTensors(writer, tensors)
  return writer.toBuffer()
}

async function describeWhisperModel(cursor) {
  await expectGgmlMagic(cursor)
  const hparams = await readInt32Fields(cursor, WHISPER_HPARAMS)
  const bci = isBciHeader(hparams) ? await readInt32Fields(cursor, BCI_HPARAMS) : null
  const melFilters = await readMelFilters(cursor)
  const tokenLengths = await readWhisperVocab(cursor)
  const tensors = await readTensorsToEnd(cursor)
  return writeWhisperDescription(cursor.size, { hparams, bci, melFilters, tokenLengths, tensors })
}

async function readVadModelType(cursor) {
  const length = await cursor.i32()
  if (length <= 0 || length > MAX_VAD_MODEL_TYPE_BYTES) {
    throw new FormatError(`VAD model type of ${length} bytes`)
  }
  return (await cursor.bytes(length)).toString('utf8')
}

async function readInt32List(cursor, count) {
  const values = []
  for (let i = 0; i < count; i++) values.push(await cursor.i32())
  return values
}

async function readVadEncoderLayers(cursor) {
  const count = await cursor.i32()
  if (count !== VAD_ENCODER_LAYERS) {
    throw new FormatError(`VAD with ${count} encoder layers, not ${VAD_ENCODER_LAYERS}`)
  }
  const layers = []
  for (let i = 0; i < count; i++) {
    layers.push(await readInt32Fields(cursor, VAD_ENCODER_LAYER_FIELDS))
  }
  return layers
}

function writeVadEncoderLayers(writer, layers) {
  for (const field of VAD_ENCODER_LAYER_FIELDS) {
    writer.i32Array(
      `${WHISPER_VAD_ARCHITECTURE}.encoder_${field}`,
      layers.map((layer) => layer[field])
    )
  }
}

function writeVadDescription(sourceSize, vad) {
  const writer = new DescriptionWriter(WHISPER_VAD_ARCHITECTURE, sourceSize)
  writer.string('whisper_vad.model_type', vad.modelType)
  writer.i32Array('whisper_vad.version', vad.version)
  writer.i32('whisper_vad.n_window', vad.nWindow)
  writer.i32('whisper_vad.n_context', vad.nContext)
  writeVadEncoderLayers(writer, vad.layers)
  writeInt32Fields(writer, WHISPER_VAD_ARCHITECTURE, vad.tail)
  writeTensors(writer, vad.tensors)
  return writer.toBuffer()
}

async function describeWhisperVad(cursor) {
  await expectGgmlMagic(cursor)
  const modelType = await readVadModelType(cursor)
  const version = await readInt32List(cursor, VAD_VERSION_FIELDS)
  const nWindow = await cursor.i32()
  const nContext = await cursor.i32()
  const layers = await readVadEncoderLayers(cursor)
  const tail = await readInt32Fields(cursor, VAD_TAIL_FIELDS)
  const tensors = await readTensorsToEnd(cursor)
  return writeVadDescription(cursor.size, {
    modelType,
    version,
    nWindow,
    nContext,
    layers,
    tail,
    tensors
  })
}

module.exports = { describeWhisperModel, describeWhisperVad }
