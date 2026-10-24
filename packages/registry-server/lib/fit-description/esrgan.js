'use strict'

const { FormatError } = require('./file-cursor')
const { DescriptionWriter } = require('./gguf-writer')
const { readTorchZip } = require('./torch-zip')
const { parseTorchPickle, tensorEntries } = require('./torch-pickle')

async function describeEsrgan(cursor) {
  const archive = await readTorchZip(cursor.handle, cursor.size)
  const tensors = tensorEntries(parseTorchPickle(archive.bytes))
  const writer = new DescriptionWriter('esrgan', archive.size)
  for (const [name, tensor] of tensors) {
    const { storage } = tensor
    const bytesPerElement = storage.type === 0 ? 4 : 2
    const entry = archive.entries.get(`${archive.prefix}data/${storage.key}`)
    const storageBytes = storage.count * bytesPerElement
    if (!entry || !Number.isSafeInteger(storageBytes) || entry.size < storageBytes) {
      throw new FormatError(`missing or truncated storage for ${name}`)
    }
    writer.tensor(name, storage.type, [...tensor.shape].reverse())
  }
  return writer.toBuffer()
}

module.exports = { describeEsrgan }
