'use strict'

const { FormatError } = require('./file-cursor')
const { isKnownGgmlType, rowsAreWhole, ggmlTensorBytes } = require('./ggml-types')

const GGUF_MAGIC = Buffer.from('GGUF', 'ascii')
const GGUF_VERSION = 3
const GGUF_ALIGNMENT = 32
const GGML_MAX_NAME = 64
const GGML_MAX_DIMS = 4

const DESCRIPTION_VERSION = 1
const ARCHITECTURE_KEY = 'general.architecture'
const VERSION_KEY = 'fit_description.version'
const SOURCE_SIZE_KEY = 'fit_description.source_size'

const GGUF_TYPE_UINT32 = 4
const GGUF_TYPE_INT32 = 5
const GGUF_TYPE_STRING = 8
const GGUF_TYPE_ARRAY = 9
const GGUF_TYPE_UINT64 = 10

function u32(value) {
  const buffer = Buffer.allocUnsafe(4)
  buffer.writeUInt32LE(value)
  return buffer
}

function i32(value) {
  const buffer = Buffer.allocUnsafe(4)
  buffer.writeInt32LE(value)
  return buffer
}

function u64(value) {
  const buffer = Buffer.allocUnsafe(8)
  buffer.writeBigUInt64LE(BigInt(value))
  return buffer
}

function ggufString(value) {
  const bytes = Buffer.from(value, 'utf8')
  return Buffer.concat([u64(bytes.length), bytes])
}

const SCALAR_ENCODERS = new Map([
  [GGUF_TYPE_UINT32, u32],
  [GGUF_TYPE_INT32, i32],
  [GGUF_TYPE_UINT64, u64],
  [GGUF_TYPE_STRING, ggufString]
])

function encodeArray(elementType, values) {
  const encode = SCALAR_ENCODERS.get(elementType)
  return Buffer.concat([u32(elementType), u64(values.length), ...values.map(encode)])
}

function encodeEntry(key, type, value) {
  return Buffer.concat([ggufString(key), u32(type), value])
}

function padTo(length, alignment) {
  return Math.ceil(length / alignment) * alignment
}

function assertDimensions(name, ne) {
  if (ne.length > GGML_MAX_DIMS) {
    throw new FormatError(`tensor '${name}' has ${ne.length} dimensions`)
  }
  const valid = ne.every(
    (value, index) => Number.isSafeInteger(value) && value >= (index > 0 ? 1 : 0)
  )
  if (!valid) throw new FormatError(`tensor '${name}' has shape [${ne.join(', ')}]`)
}

function assertTensor({ name, type, ne }) {
  if (Buffer.byteLength(name, 'utf8') >= GGML_MAX_NAME) {
    throw new FormatError(`tensor name '${name}' is too long for a GGUF description`)
  }
  assertDimensions(name, ne)
  if (!isKnownGgmlType(type)) throw new FormatError(`tensor '${name}' has unknown type ${type}`)
  if (!rowsAreWhole(type, ne)) throw new FormatError(`tensor '${name}' rows are not whole blocks`)
}

function encodeTensorInfo({ name, type, ne }, offset) {
  return Buffer.concat([ggufString(name), u32(ne.length), ...ne.map(u64), u32(type), u64(offset)])
}

function encodeTensorInfos(tensors) {
  let offset = 0
  return tensors.map((tensor) => {
    const info = encodeTensorInfo(tensor, offset)
    offset += padTo(ggmlTensorBytes(tensor.type, tensor.ne), GGUF_ALIGNMENT)
    return info
  })
}

class DescriptionWriter {
  constructor(architecture, sourceSize) {
    this.entries = []
    this.tensors = []
    this.tensorNames = new Set()
    this.string(ARCHITECTURE_KEY, architecture)
    this.u32(VERSION_KEY, DESCRIPTION_VERSION)
    this.u64(SOURCE_SIZE_KEY, sourceSize)
  }

  u32(key, value) {
    this.entries.push(encodeEntry(key, GGUF_TYPE_UINT32, u32(value)))
  }

  i32(key, value) {
    this.entries.push(encodeEntry(key, GGUF_TYPE_INT32, i32(value)))
  }

  u64(key, value) {
    this.entries.push(encodeEntry(key, GGUF_TYPE_UINT64, u64(value)))
  }

  string(key, value) {
    this.entries.push(encodeEntry(key, GGUF_TYPE_STRING, ggufString(value)))
  }

  u32Array(key, values) {
    this.entries.push(encodeEntry(key, GGUF_TYPE_ARRAY, encodeArray(GGUF_TYPE_UINT32, values)))
  }

  i32Array(key, values) {
    this.entries.push(encodeEntry(key, GGUF_TYPE_ARRAY, encodeArray(GGUF_TYPE_INT32, values)))
  }

  u64Array(key, values) {
    this.entries.push(encodeEntry(key, GGUF_TYPE_ARRAY, encodeArray(GGUF_TYPE_UINT64, values)))
  }

  stringArray(key, values) {
    this.entries.push(encodeEntry(key, GGUF_TYPE_ARRAY, encodeArray(GGUF_TYPE_STRING, values)))
  }

  tensor(name, type, ne) {
    const tensor = { name, type, ne }
    assertTensor(tensor)
    if (this.tensorNames.has(name)) throw new FormatError(`tensor '${name}' is listed twice`)
    this.tensorNames.add(name)
    this.tensors.push(tensor)
  }

  toBuffer() {
    const header = Buffer.concat([
      GGUF_MAGIC,
      u32(GGUF_VERSION),
      u64(this.tensors.length),
      u64(this.entries.length)
    ])
    const body = Buffer.concat([header, ...this.entries, ...encodeTensorInfos(this.tensors)])
    return Buffer.concat([body, Buffer.alloc(padTo(body.length, GGUF_ALIGNMENT) - body.length)])
  }
}

module.exports = { DescriptionWriter, DESCRIPTION_VERSION }
