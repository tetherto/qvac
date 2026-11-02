'use strict'

const { FormatError } = require('./file-cursor')
const { DescriptionWriter } = require('./gguf-writer')
const { GGML_TYPE_F32, GGML_TYPE_I32 } = require('./ggml-types')

const BCI_EMBEDDER_ARCHITECTURE = 'bci_embedder'
const BCI_EMBEDDER_MAGIC = 0x42434945
const BCI_EMBEDDER_FORMAT_VERSION = 1

const HEADER_FIELDS = [
  'num_features',
  'embed_dim',
  'kernel_size1',
  'kernel_size2',
  'stride2',
  'num_days',
  'num_months',
  'rank'
]
const CONV_ARRAYS = 4
const DAY_ARRAYS = ['a', 'b', 'bias']
const MONTH_ARRAYS = ['weight', 'bias']
const ELEMENT_BYTES = 4
const MAX_PERIODS = 1 << 16

async function expectEmbedderMagic(cursor) {
  const magic = await cursor.u32()
  const version = await cursor.u32()
  if (magic !== BCI_EMBEDDER_MAGIC || version !== BCI_EMBEDDER_FORMAT_VERSION) {
    throw new FormatError(`magic 0x${magic.toString(16)} v${version} is not a BCI embedder`)
  }
}

async function readHeader(cursor) {
  const header = {}
  for (const field of HEADER_FIELDS) header[field] = await cursor.u32()
  if (header.num_days > MAX_PERIODS || header.num_months > MAX_PERIODS) {
    throw new FormatError(`embedder with ${header.num_days} days and ${header.num_months} months`)
  }
  return header
}

async function readArray(cursor, name, type) {
  const count = await cursor.u32()
  cursor.skip(count * ELEMENT_BYTES)
  return { name, type, ne: [count] }
}

async function readFloatArrays(cursor, names) {
  const arrays = []
  for (const name of names) arrays.push(await readArray(cursor, name, GGML_TYPE_F32))
  return arrays
}

function convArrayNames() {
  return Array.from({ length: CONV_ARRAYS }, (_, index) => `conv.${index}`)
}

function periodArrayNames(period, count, arrays) {
  return Array.from({ length: count }, (_, index) =>
    arrays.map((array) => `${period}.${index}.${array}`)
  ).flat()
}

async function readEmbedderArrays(cursor, header) {
  const conv = await readFloatArrays(cursor, convArrayNames())
  const sessions = await readArray(cursor, 'session_to_day', GGML_TYPE_I32)
  const days = await readFloatArrays(cursor, periodArrayNames('day', header.num_days, DAY_ARRAYS))
  const months = await readFloatArrays(
    cursor,
    periodArrayNames('month', header.num_months, MONTH_ARRAYS)
  )
  return [...conv, sessions, ...days, ...months]
}

function writeEmbedderDescription(sourceSize, header, arrays) {
  const writer = new DescriptionWriter(BCI_EMBEDDER_ARCHITECTURE, sourceSize)
  writer.u32('bci_embedder.format_version', BCI_EMBEDDER_FORMAT_VERSION)
  for (const [field, value] of Object.entries(header)) writer.u32(`bci_embedder.${field}`, value)
  for (const array of arrays) writer.tensor(array.name, array.type, array.ne)
  return writer.toBuffer()
}

async function describeBciEmbedder(cursor) {
  await expectEmbedderMagic(cursor)
  const header = await readHeader(cursor)
  const arrays = await readEmbedderArrays(cursor, header)
  if (!cursor.atEnd) throw new FormatError(`${cursor.remaining} bytes follow the embedder weights`)
  return writeEmbedderDescription(cursor.size, header, arrays)
}

module.exports = { describeBciEmbedder }
