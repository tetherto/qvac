'use strict'

const { FormatError } = require('./file-cursor')
const { DescriptionWriter } = require('./gguf-writer')
const { lengthHistogram } = require('./token-lengths')

const SENTENCEPIECE_ARCHITECTURE = 'sentencepiece'
const MAX_SENTENCEPIECE_BYTES = 64 * 1024 * 1024

const WIRE_VARINT = 0
const WIRE_FIXED64 = 1
const WIRE_LENGTH_DELIMITED = 2
const WIRE_FIXED32 = 5
const FIXED64_BYTES = 8
const FIXED32_BYTES = 4
const VARINT_PAYLOAD_BITS = 7
const VARINT_CONTINUATION = 0x80
const VARINT_PAYLOAD_MASK = 0x7f
const MAX_VARINT_BYTES = 10
const FIELD_NUMBER_SHIFT = 3
const WIRE_TYPE_MASK = 0x7

const MODEL_PIECES_FIELD = 1
const MODEL_TRAINER_SPEC_FIELD = 2
const MODEL_NORMALIZER_SPEC_FIELD = 3
const MODEL_DENORMALIZER_SPEC_FIELD = 5
const PIECE_TEXT_FIELD = 1
const TRAINER_MODEL_TYPE_FIELD = 3
const NORMALIZER_CHARSMAP_FIELD = 2
const DEFAULT_MODEL_TYPE = 1

class ProtoReader {
  constructor(buffer, start, end) {
    this.buffer = buffer
    this.position = start
    this.end = end
  }

  get atEnd() {
    return this.position >= this.end
  }

  advance(length) {
    if (length > this.end - this.position) {
      throw new FormatError(`protobuf field runs past its message at ${this.position}`)
    }
    const start = this.position
    this.position += length
    return start
  }

  byte() {
    return this.buffer[this.advance(1)]
  }

  varint() {
    let value = 0
    for (let index = 0; index < MAX_VARINT_BYTES; index++) {
      const byte = this.byte()
      value += (byte & VARINT_PAYLOAD_MASK) * 2 ** (VARINT_PAYLOAD_BITS * index)
      if ((byte & VARINT_CONTINUATION) === 0) return value
    }
    throw new FormatError(`protobuf varint longer than ${MAX_VARINT_BYTES} bytes`)
  }

  field() {
    const tag = this.varint()
    return { number: Math.floor(tag / 2 ** FIELD_NUMBER_SHIFT), wireType: tag & WIRE_TYPE_MASK }
  }

  message() {
    const length = this.varint()
    const start = this.advance(length)
    return new ProtoReader(this.buffer, start, start + length)
  }

  skip(wireType) {
    if (wireType === WIRE_VARINT) this.varint()
    else if (wireType === WIRE_FIXED64) this.advance(FIXED64_BYTES)
    else if (wireType === WIRE_FIXED32) this.advance(FIXED32_BYTES)
    else if (wireType === WIRE_LENGTH_DELIMITED) this.advance(this.varint())
    else throw new FormatError(`protobuf wire type ${wireType} is not supported`)
  }
}

function readMessage(reader, handlers) {
  while (!reader.atEnd) {
    const { number, wireType } = reader.field()
    const handler = handlers[number]
    if (handler && handler.wireType === wireType) handler.read(reader)
    else reader.skip(wireType)
  }
}

function lengthOf(reader) {
  const field = reader.message()
  return field.end - field.position
}

function readPieceLength(reader) {
  let length = 0
  readMessage(reader.message(), {
    [PIECE_TEXT_FIELD]: {
      wireType: WIRE_LENGTH_DELIMITED,
      read: (piece) => (length = lengthOf(piece))
    }
  })
  return length
}

function readCharsmapBytes(reader) {
  let bytes = 0
  readMessage(reader.message(), {
    [NORMALIZER_CHARSMAP_FIELD]: {
      wireType: WIRE_LENGTH_DELIMITED,
      read: (spec) => (bytes = lengthOf(spec))
    }
  })
  return bytes
}

function readModelType(reader) {
  let modelType = DEFAULT_MODEL_TYPE
  readMessage(reader.message(), {
    [TRAINER_MODEL_TYPE_FIELD]: {
      wireType: WIRE_VARINT,
      read: (spec) => (modelType = spec.varint())
    }
  })
  return modelType
}

function summarizeSentencePiece(buffer) {
  const summary = {
    pieceLengths: [],
    modelType: DEFAULT_MODEL_TYPE,
    precompiledCharsmapBytes: 0,
    denormalizerCharsmapBytes: 0
  }

  readMessage(new ProtoReader(buffer, 0, buffer.length), {
    [MODEL_PIECES_FIELD]: {
      wireType: WIRE_LENGTH_DELIMITED,
      read: (model) => summary.pieceLengths.push(readPieceLength(model))
    },
    [MODEL_TRAINER_SPEC_FIELD]: {
      wireType: WIRE_LENGTH_DELIMITED,
      read: (model) => (summary.modelType = readModelType(model))
    },
    [MODEL_NORMALIZER_SPEC_FIELD]: {
      wireType: WIRE_LENGTH_DELIMITED,
      read: (model) => (summary.precompiledCharsmapBytes = readCharsmapBytes(model))
    },
    [MODEL_DENORMALIZER_SPEC_FIELD]: {
      wireType: WIRE_LENGTH_DELIMITED,
      read: (model) => (summary.denormalizerCharsmapBytes = readCharsmapBytes(model))
    }
  })

  if (summary.pieceLengths.length === 0) throw new FormatError('SentencePiece model has no pieces')
  return summary
}

function writeSentencePieceSummary(writer, prefix, summary) {
  writer.u32(`${prefix}.model_type`, summary.modelType)
  writer.u32(`${prefix}.n_pieces`, summary.pieceLengths.length)
  writer.u32Array(`${prefix}.piece_length_counts`, lengthHistogram(summary.pieceLengths))
  writer.u64(`${prefix}.precompiled_charsmap_bytes`, summary.precompiledCharsmapBytes)
  writer.u64(`${prefix}.denormalizer_charsmap_bytes`, summary.denormalizerCharsmapBytes)
}

async function describeSentencePiece(cursor) {
  if (cursor.size === 0 || cursor.size > MAX_SENTENCEPIECE_BYTES) {
    throw new FormatError(`SentencePiece model of ${cursor.size} bytes`)
  }
  const summary = summarizeSentencePiece(Buffer.from(await cursor.bytes(cursor.size)))
  const writer = new DescriptionWriter(SENTENCEPIECE_ARCHITECTURE, cursor.size)
  writeSentencePieceSummary(writer, SENTENCEPIECE_ARCHITECTURE, summary)
  return writer.toBuffer()
}

module.exports = { describeSentencePiece, summarizeSentencePiece, writeSentencePieceSummary }
