'use strict'

const fsPromises = require('fs').promises

const READ_CHUNK_BYTES = 1024 * 1024

class FormatError extends Error {}

class FileCursor {
  static async open(filePath) {
    const handle = await fsPromises.open(filePath, 'r')
    const { size } = await handle.stat()
    return new FileCursor(handle, size)
  }

  constructor(handle, size) {
    this.handle = handle
    this.size = size
    this.position = 0
    this.chunk = Buffer.alloc(0)
    this.chunkStart = 0
  }

  get remaining() {
    return this.size - this.position
  }

  get atEnd() {
    return this.position === this.size
  }

  async bytes(length) {
    this.ensureAvailable(length)
    if (!this.chunkCovers(length)) await this.fillChunk(length)

    const start = this.position - this.chunkStart
    this.position += length
    return this.chunk.subarray(start, start + length)
  }

  async u32() {
    return (await this.bytes(4)).readUInt32LE(0)
  }

  async i32() {
    return (await this.bytes(4)).readInt32LE(0)
  }

  async u64() {
    const value = (await this.bytes(8)).readBigUInt64LE(0)
    if (value > BigInt(Number.MAX_SAFE_INTEGER)) {
      throw new FormatError(`count ${value} at ${this.position - 8} is out of range`)
    }
    return Number(value)
  }

  skip(length) {
    this.ensureAvailable(length)
    this.position += length
  }

  rewind() {
    this.position = 0
  }

  ensureAvailable(length) {
    if (!Number.isSafeInteger(length) || length < 0 || length > this.remaining) {
      throw new FormatError(`${length} bytes at ${this.position} run past the end of the file`)
    }
  }

  chunkCovers(length) {
    const start = this.position - this.chunkStart
    return start >= 0 && start + length <= this.chunk.length
  }

  async fillChunk(length) {
    const size = Math.min(Math.max(length, READ_CHUNK_BYTES), this.remaining)
    const chunk = Buffer.allocUnsafe(size)
    const { bytesRead } = await this.handle.read(chunk, 0, size, this.position)
    if (bytesRead !== size) {
      throw new FormatError(`short read of ${size} bytes at ${this.position}`)
    }
    this.chunk = chunk
    this.chunkStart = this.position
  }

  close() {
    return this.handle.close()
  }
}

async function withFileCursor(filePath, read) {
  const cursor = await FileCursor.open(filePath)
  try {
    return await read(cursor)
  } finally {
    await cursor.close()
  }
}

module.exports = { FileCursor, FormatError, withFileCursor }
