'use strict'

const { FormatError } = require('./file-cursor')
const { isKnownGgmlType, rowsAreWhole, ggmlTensorBytes } = require('./ggml-types')

const GGML_FILE_MAGIC = 0x67676d6c
const GGML_MAX_DIMS = 4
const MAX_TENSOR_NAME_BYTES = 256

async function expectGgmlMagic(cursor) {
  const magic = await cursor.u32()
  if (magic !== GGML_FILE_MAGIC) {
    throw new FormatError(`magic 0x${magic.toString(16)} is not a ggml model file`)
  }
}

async function readInt32Fields(cursor, names) {
  const fields = {}
  for (const name of names) fields[name] = await cursor.i32()
  return fields
}

async function readCount(cursor, max, what) {
  const count = await cursor.i32()
  if (count < 0 || count > max) throw new FormatError(`${what} count ${count} is out of range`)
  return count
}

async function readDimensions(cursor, nDims) {
  const ne = []
  for (let i = 0; i < nDims; i++) ne.push(await cursor.i32())
  return ne
}

async function readTensorHeader(cursor) {
  const nDims = await cursor.i32()
  const nameLength = await cursor.i32()
  const type = await cursor.i32()

  if (nDims < 0 || nDims > GGML_MAX_DIMS) throw new FormatError(`tensor with ${nDims} dimensions`)
  if (nameLength <= 0 || nameLength > MAX_TENSOR_NAME_BYTES) {
    throw new FormatError(`tensor name of ${nameLength} bytes`)
  }
  if (!isKnownGgmlType(type)) throw new FormatError(`tensor of unknown type ${type}`)

  const ne = await readDimensions(cursor, nDims)
  const name = (await cursor.bytes(nameLength)).toString('utf8')
  return { name, type, ne }
}

async function readTensor(cursor) {
  const tensor = await readTensorHeader(cursor)
  if (tensor.ne.some((value) => value < 1) || !rowsAreWhole(tensor.type, tensor.ne)) {
    throw new FormatError(`tensor '${tensor.name}' has shape [${tensor.ne.join(', ')}]`)
  }
  cursor.skip(ggmlTensorBytes(tensor.type, tensor.ne))
  return tensor
}

async function readTensorsToEnd(cursor) {
  const tensors = []
  while (!cursor.atEnd) tensors.push(await readTensor(cursor))
  return tensors
}

function writeTensors(writer, tensors) {
  for (const tensor of tensors) writer.tensor(tensor.name, tensor.type, tensor.ne)
}

module.exports = {
  expectGgmlMagic,
  readInt32Fields,
  readCount,
  readTensorsToEnd,
  writeTensors
}
