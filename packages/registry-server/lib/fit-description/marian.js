'use strict'

const { FormatError } = require('./file-cursor')
const { DescriptionWriter } = require('./gguf-writer')

const MARIAN_ARCHITECTURE = 'marian'
const MARIAN_SHORTLIST_ARCHITECTURE = 'marian_shortlist'

const MARIAN_BINARY_FILE_VERSION = 1
const MARIAN_CONFIG_ITEM = 'special:model.yml'
const MAX_ITEMS = 1 << 16
const MAX_ITEM_NAME_BYTES = 4096
const MAX_SHAPE_RANK = 16
const MAX_ITEM_TYPE = 0xffffffff
const MAX_CONFIG_BYTES = 1024 * 1024
const NAME_TERMINATOR = '\0'

const BINARY_SHORTLIST_MAGIC = 0xf11a48d5013417f5n
const SHORTLIST_MAGIC_BYTES = 8
const SHORTLIST_HEADER_FIELDS = ['first_num', 'best_num', 'word_to_offset_size', 'short_lists_size']
const SHORTLIST_CHECKSUM_BYTES = 8
const SHORTLIST_OFFSET_BYTES = 8
const SHORTLIST_WORD_INDEX_BYTES = 4

async function expectMarianVersion(cursor) {
  const version = await cursor.u64()
  if (version !== MARIAN_BINARY_FILE_VERSION) {
    throw new FormatError(`binary version ${version} is not a Marian model`)
  }
}

async function readItemHeader(cursor) {
  const header = {
    nameLength: await cursor.u64(),
    type: await cursor.u64(),
    shapeRank: await cursor.u64(),
    dataBytes: await cursor.u64()
  }
  if (header.nameLength === 0 || header.nameLength > MAX_ITEM_NAME_BYTES) {
    throw new FormatError(`Marian item name of ${header.nameLength} bytes`)
  }
  if (header.shapeRank > MAX_SHAPE_RANK) {
    throw new FormatError(`Marian item of rank ${header.shapeRank}`)
  }
  if (header.type > MAX_ITEM_TYPE) throw new FormatError(`Marian item of type ${header.type}`)
  return header
}

async function readItemHeaders(cursor) {
  const count = await cursor.u64()
  if (count === 0 || count > MAX_ITEMS) throw new FormatError(`Marian model with ${count} items`)
  const headers = []
  for (let i = 0; i < count; i++) headers.push(await readItemHeader(cursor))
  return headers
}

async function readItemName(cursor, header) {
  const name = (await cursor.bytes(header.nameLength)).toString('utf8')
  if (!name.endsWith(NAME_TERMINATOR)) throw new FormatError('Marian item name is not terminated')
  return name.slice(0, -NAME_TERMINATOR.length)
}

async function readItemShape(cursor, header) {
  const shape = []
  for (let i = 0; i < header.shapeRank; i++) shape.push(await cursor.i32())
  return shape
}

async function readItemNames(cursor, headers) {
  const names = []
  for (const header of headers) names.push(await readItemName(cursor, header))
  return names
}

async function readItemShapes(cursor, headers) {
  const shapes = []
  for (const header of headers) shapes.push(await readItemShape(cursor, header))
  return shapes
}

async function readConfigItem(cursor, header) {
  if (header.dataBytes > MAX_CONFIG_BYTES) {
    throw new FormatError(`Marian config of ${header.dataBytes} bytes`)
  }
  return (await cursor.bytes(header.dataBytes)).toString('utf8').replace(/\0+$/, '')
}

async function readItemData(cursor, items) {
  let config = null
  for (const item of items) {
    if (item.name === MARIAN_CONFIG_ITEM) config = await readConfigItem(cursor, item.header)
    else cursor.skip(item.header.dataBytes)
  }
  if (config === null) throw new FormatError(`Marian model has no ${MARIAN_CONFIG_ITEM}`)
  return config
}

function zipItems(headers, names, shapes) {
  return headers.map((header, index) => ({ header, name: names[index], shape: shapes[index] }))
}

function writeMarianDescription(sourceSize, config, items) {
  const writer = new DescriptionWriter(MARIAN_ARCHITECTURE, sourceSize)
  writer.string('marian.config', config)
  writer.stringArray(
    'marian.items.names',
    items.map((item) => item.name)
  )
  writer.u32Array(
    'marian.items.types',
    items.map((item) => item.header.type)
  )
  writer.u32Array(
    'marian.items.shape_ranks',
    items.map((item) => item.shape.length)
  )
  writer.i32Array(
    'marian.items.shapes',
    items.flatMap((item) => item.shape)
  )
  writer.u64Array(
    'marian.items.data_bytes',
    items.map((item) => item.header.dataBytes)
  )
  return writer.toBuffer()
}

async function describeMarianModel(cursor) {
  await expectMarianVersion(cursor)
  const headers = await readItemHeaders(cursor)
  const names = await readItemNames(cursor, headers)
  const shapes = await readItemShapes(cursor, headers)
  cursor.skip(await cursor.u64())
  const items = zipItems(headers, names, shapes)
  const config = await readItemData(cursor, items)
  if (!cursor.atEnd) throw new FormatError(`${cursor.remaining} bytes follow the Marian items`)
  return writeMarianDescription(cursor.size, config, items)
}

async function expectShortlistMagic(cursor) {
  const magic = (await cursor.bytes(SHORTLIST_MAGIC_BYTES)).readBigUInt64LE(0)
  if (magic !== BINARY_SHORTLIST_MAGIC) throw new FormatError('not a binary shortlist')
}

async function readShortlistHeader(cursor) {
  const header = {}
  for (const field of SHORTLIST_HEADER_FIELDS) header[field] = await cursor.u64()
  return header
}

function shortlistTableBytes(header) {
  return (
    header.word_to_offset_size * SHORTLIST_OFFSET_BYTES +
    header.short_lists_size * SHORTLIST_WORD_INDEX_BYTES
  )
}

function writeShortlistDescription(sourceSize, header) {
  const writer = new DescriptionWriter(MARIAN_SHORTLIST_ARCHITECTURE, sourceSize)
  for (const [field, value] of Object.entries(header)) {
    writer.u64(`${MARIAN_SHORTLIST_ARCHITECTURE}.${field}`, value)
  }
  return writer.toBuffer()
}

async function describeMarianShortlist(cursor) {
  await expectShortlistMagic(cursor)
  cursor.skip(SHORTLIST_CHECKSUM_BYTES)
  const header = await readShortlistHeader(cursor)
  if (shortlistTableBytes(header) !== cursor.remaining) {
    throw new FormatError('binary shortlist tables do not match the file size')
  }
  return writeShortlistDescription(cursor.size, header)
}

module.exports = { describeMarianModel, describeMarianShortlist }
