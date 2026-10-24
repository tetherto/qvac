'use strict'

const { FormatError } = require('./file-cursor')

const MAX_PICKLE_BYTES = 16 * 1024 * 1024
const CRC_TABLE = Array.from({ length: 256 }, (_, value) => {
  for (let bit = 0; bit < 8; bit++) value = (value >>> 1) ^ (value & 1 ? 0xedb88320 : 0)
  return value >>> 0
})

function crc32(bytes) {
  let crc = 0xffffffff
  for (const byte of bytes) crc = (crc >>> 8) ^ CRC_TABLE[(crc ^ byte) & 255]
  return (crc ^ 0xffffffff) >>> 0
}

async function readAt(handle, size, offset, length) {
  if (!Number.isSafeInteger(offset) || offset < 0 || length < 0 || length > size - offset) {
    throw new FormatError('ZIP entry runs past the end of the checkpoint')
  }
  const bytes = Buffer.alloc(length)
  const read = await handle.read(bytes, 0, length, offset)
  if (read.bytesRead !== length) throw new FormatError('short ZIP read')
  return bytes
}

async function directory(handle, size) {
  const final = size >= 22 ? await readAt(handle, size, size - 22, 22) : Buffer.alloc(0)
  const plain =
    final.length === 22 && final.readUInt32LE(0) === 0x06054b50 && final.readUInt16LE(20) === 0
  const tailOffset = Math.max(0, size - (plain ? 22 : 65557))
  const tail = await readAt(handle, size, tailOffset, size - tailOffset)
  let end = tail.length - 22
  while (end >= 0) {
    if (
      tail.readUInt32LE(end) === 0x06054b50 &&
      end + 22 + tail.readUInt16LE(end + 20) === tail.length
    ) {
      break
    }
    end--
  }
  if (end < 0) throw new FormatError('no ZIP directory')
  const count = tail.readUInt16LE(end + 10)
  const length = tail.readUInt32LE(end + 12)
  const offset = tail.readUInt32LE(end + 16)
  if (
    tail.readUInt32LE(end + 4) !== 0 ||
    tail.readUInt16LE(end + 8) !== count ||
    count === 0xffff ||
    offset === 0xffffffff ||
    length === 0xffffffff ||
    length > MAX_PICKLE_BYTES ||
    offset + length > tailOffset + end
  ) {
    throw new FormatError('unsupported ZIP directory')
  }
  const bytes = await readAt(handle, size, offset, length)
  const entries = new Map()
  let position = 0
  for (let index = 0; index < count; index++) {
    if (position + 46 > bytes.length || bytes.readUInt32LE(position) !== 0x02014b50) {
      throw new FormatError('invalid ZIP directory entry')
    }
    const nameLength = bytes.readUInt16LE(position + 28)
    const next =
      position +
      46 +
      nameLength +
      bytes.readUInt16LE(position + 30) +
      bytes.readUInt16LE(position + 32)
    if (next > bytes.length) throw new FormatError('truncated ZIP directory entry')
    const name = bytes.toString('utf8', position + 46, position + 46 + nameLength)
    const entry = {
      name,
      flags: bytes.readUInt16LE(position + 8),
      method: bytes.readUInt16LE(position + 10),
      crc: bytes.readUInt32LE(position + 16),
      packed: bytes.readUInt32LE(position + 20),
      size: bytes.readUInt32LE(position + 24),
      offset: bytes.readUInt32LE(position + 42)
    }
    if (
      entries.has(name) ||
      bytes.readUInt16LE(position + 34) !== 0 ||
      entry.method !== 0 ||
      (entry.flags & ~0x808) !== 0 ||
      entry.packed !== entry.size ||
      entry.offset + 30 + nameLength + entry.size > offset
    ) {
      throw new FormatError('unsupported or invalid PyTorch ZIP entry')
    }
    entries.set(name, entry)
    position = next
  }
  if (position !== bytes.length) throw new FormatError('bytes after ZIP directory')
  return { entries, offset }
}

async function entryOffset(handle, size, entry, directoryOffset) {
  const header = await readAt(handle, size, entry.offset, 30)
  if (
    header.readUInt32LE(0) !== 0x04034b50 ||
    header.readUInt16LE(6) !== entry.flags ||
    header.readUInt16LE(8) !== entry.method
  ) {
    throw new FormatError('invalid ZIP local header')
  }
  const nameLength = header.readUInt16LE(26)
  const name = await readAt(handle, size, entry.offset + 30, nameLength)
  const offset = entry.offset + 30 + nameLength + header.readUInt16LE(28)
  if (name.toString('utf8') !== entry.name || offset + entry.size > directoryOffset) {
    throw new FormatError('ZIP storage runs past the data section')
  }
  return offset
}

async function readTorchZip(handle, size) {
  const { entries, offset } = await directory(handle, size)
  const pickles = [...entries.values()].filter((entry) => /(^|\/)data\.pkl$/.test(entry.name))
  if (pickles.length !== 1 || pickles[0].size > MAX_PICKLE_BYTES) {
    throw new FormatError('expected one bounded data.pkl')
  }
  const pickle = pickles[0]
  const prefix = pickle.name.slice(0, -'data.pkl'.length)
  // Local headers validate storage bounds without reading tensor payloads.
  for (const entry of entries.values()) {
    entry.dataOffset = await entryOffset(handle, size, entry, offset)
  }
  const bytes = await readAt(handle, size, pickle.dataOffset, pickle.size)
  if (crc32(bytes) !== pickle.crc) throw new FormatError('data.pkl checksum mismatch')
  return { bytes, entries, prefix, size }
}

module.exports = { readTorchZip, crc32 }
