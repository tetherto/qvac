'use strict'

// Builds the metadata-only and split GGUF fixtures the fit tests compare
// against, from whatever real model the suite already downloaded.
//
// A metadata-only GGUF is the header, the KV pairs and the tensor infos, padded
// to the data alignment, with no data section. gguf_write_to_file writes that
// padding before it returns for only_meta, so the file it produces is
// byte-identical to the first `dataOffset` bytes of the full artefact — hence
// `writeMetaOnly` truncates rather than re-serialising.

const fs = require('bare-fs')
const path = require('bare-path')

const MAGIC = 'GGUF'
const DEFAULT_ALIGNMENT = 32
// A single tensor of a real model does not fit in memory comfortably.
const COPY_CHUNK = 8 * 1024 * 1024

// gguf_type
const TYPE = {
  UINT8: 0,
  INT8: 1,
  UINT16: 2,
  INT16: 3,
  UINT32: 4,
  INT32: 5,
  FLOAT32: 6,
  BOOL: 7,
  STRING: 8,
  ARRAY: 9,
  UINT64: 10,
  INT64: 11,
  FLOAT64: 12
}

const SCALAR_SIZE = {
  [TYPE.UINT8]: 1,
  [TYPE.INT8]: 1,
  [TYPE.UINT16]: 2,
  [TYPE.INT16]: 2,
  [TYPE.UINT32]: 4,
  [TYPE.INT32]: 4,
  [TYPE.FLOAT32]: 4,
  [TYPE.BOOL]: 1,
  [TYPE.UINT64]: 8,
  [TYPE.INT64]: 8,
  [TYPE.FLOAT64]: 8
}

// llama_split_path: the loader derives every sibling shard from the first one,
// so the names have to match this exactly.
function splitPath(prefix, splitNo, splitCount) {
  const pad = (n) => String(n).padStart(5, '0')
  return `${prefix}-${pad(splitNo + 1)}-of-${pad(splitCount)}.gguf`
}

function pad(offset, alignment) {
  const rem = offset % alignment
  return rem === 0 ? offset : offset + (alignment - rem)
}

function createCursor(buf) {
  let off = 0
  const need = (n) => {
    if (off + n > buf.length) throw new RangeError('GGUF metadata exceeds the buffer')
  }
  return {
    get offset() {
      return off
    },
    skip(n) {
      need(n)
      off += n
    },
    u32() {
      need(4)
      const v = buf.readUInt32LE(off)
      off += 4
      return v
    },
    u64() {
      need(8)
      const v = Number(buf.readBigUInt64LE(off))
      off += 8
      return v
    },
    str() {
      const len = this.u64()
      need(len)
      const s = buf.toString('utf8', off, off + len)
      off += len
      return s
    }
  }
}

function skipValue(cur, type) {
  if (type === TYPE.STRING) {
    cur.str()
    return
  }
  if (type === TYPE.ARRAY) {
    const elemType = cur.u32()
    const count = cur.u64()
    if (elemType === TYPE.STRING) {
      for (let i = 0; i < count; i++) cur.str()
      return
    }
    if (elemType === TYPE.ARRAY) throw new Error('nested GGUF arrays are not supported')
    const size = SCALAR_SIZE[elemType]
    if (size === undefined) throw new Error(`unknown GGUF array element type ${elemType}`)
    cur.skip(size * count)
    return
  }
  const size = SCALAR_SIZE[type]
  if (size === undefined) throw new Error(`unknown GGUF value type ${type}`)
  cur.skip(size)
}

function parseMetadata(buf) {
  const cur = createCursor(buf)

  if (buf.toString('ascii', 0, 4) !== MAGIC) throw new Error('not a GGUF file')
  cur.skip(4)
  const version = cur.u32()
  const nTensors = cur.u64()
  const nKv = cur.u64()

  const kvStart = cur.offset
  let alignment = DEFAULT_ALIGNMENT
  for (let i = 0; i < nKv; i++) {
    const key = cur.str()
    const type = cur.u32()
    if (key === 'general.alignment') {
      if (type !== TYPE.UINT32) throw new Error('general.alignment is not a uint32')
      alignment = buf.readUInt32LE(cur.offset)
    }
    skipValue(cur, type)
  }
  const kvBytes = buf.subarray(kvStart, cur.offset)

  const tensors = []
  for (let i = 0; i < nTensors; i++) {
    const name = cur.str()
    const nDims = cur.u32()
    const dims = []
    for (let d = 0; d < nDims; d++) dims.push(cur.u64())
    const type = cur.u32()
    const offset = cur.u64()
    tensors.push({ name, dims, type, offset })
  }

  return { version, nKv, kvBytes, tensors, alignment, dataOffset: pad(cur.offset, alignment) }
}

// Reads just enough of the file to parse the metadata. Tokenizer arrays make
// the section large on real models, so grow until it parses.
function readGguf(filePath) {
  const fileSize = fs.statSync(filePath).size
  const fd = fs.openSync(filePath, 'r')
  try {
    for (let size = Math.min(1 << 22, fileSize); ; size = Math.min(size * 4, fileSize)) {
      const buf = Buffer.alloc(size)
      fs.readSync(fd, buf, 0, size, 0)
      try {
        const meta = parseMetadata(buf)
        return { ...meta, fileSize }
      } catch (err) {
        if (!(err instanceof RangeError) || size === fileSize) throw err
      }
    }
  } finally {
    fs.closeSync(fd)
  }
}

// Tensor data is laid out contiguously and every tensor starts on an alignment
// boundary, so the gap to the next tensor is the payload plus its padding. That
// avoids a ggml block-size table here, and the trailing padding bytes are inert
// once the infos are rewritten with fresh offsets.
function tensorExtents(meta) {
  const ordered = [...meta.tensors].sort((a, b) => a.offset - b.offset)
  return ordered.map((tensor, i) => {
    const end = i + 1 < ordered.length ? ordered[i + 1].offset : meta.fileSize - meta.dataOffset
    return { ...tensor, size: end - tensor.offset }
  })
}

function writeString(chunks, value) {
  const bytes = Buffer.from(value, 'utf8')
  const len = Buffer.alloc(8)
  len.writeBigUInt64LE(BigInt(bytes.length))
  chunks.push(len, bytes)
}

function writeKv(chunks, key, type, value) {
  writeString(chunks, key)
  const head = Buffer.alloc(4)
  head.writeUInt32LE(type)
  chunks.push(head)
  const body = Buffer.alloc(SCALAR_SIZE[type])
  if (type === TYPE.UINT16) body.writeUInt16LE(value)
  else if (type === TYPE.INT32) body.writeInt32LE(value)
  else throw new Error(`writeKv does not serialise type ${type}`)
  chunks.push(body)
}

function writeTensorInfo(chunks, tensor, offset) {
  writeString(chunks, tensor.name)
  const head = Buffer.alloc(4 + 8 * tensor.dims.length + 4 + 8)
  let at = 0
  head.writeUInt32LE(tensor.dims.length, at)
  at += 4
  for (const dim of tensor.dims) {
    head.writeBigUInt64LE(BigInt(dim), at)
    at += 8
  }
  head.writeUInt32LE(tensor.type, at)
  at += 4
  head.writeBigUInt64LE(BigInt(offset), at)
  chunks.push(head)
}

function writeShard({
  destPath,
  srcPath,
  meta,
  tensors,
  nKv,
  kvBytes,
  splitNo,
  splitCount,
  metaOnly
}) {
  const chunks = []

  const header = Buffer.alloc(4 + 4 + 8 + 8)
  header.write(MAGIC, 0, 'ascii')
  header.writeUInt32LE(meta.version, 4)
  header.writeBigUInt64LE(BigInt(tensors.length), 8)
  header.writeBigUInt64LE(BigInt(nKv + 3), 16)
  chunks.push(header)

  if (kvBytes) chunks.push(kvBytes)
  writeKv(chunks, 'split.no', TYPE.UINT16, splitNo)
  writeKv(chunks, 'split.count', TYPE.UINT16, splitCount)
  writeKv(chunks, 'split.tensors.count', TYPE.INT32, meta.tensors.length)

  const placed = []
  let dataSize = 0
  for (const tensor of tensors) {
    placed.push({ tensor, offset: dataSize })
    dataSize = pad(dataSize + tensor.size, meta.alignment)
  }
  for (const { tensor, offset } of placed) writeTensorInfo(chunks, tensor, offset)

  const metaSize = chunks.reduce((sum, chunk) => sum + chunk.length, 0)
  const dataOffset = pad(metaSize, meta.alignment)
  chunks.push(Buffer.alloc(dataOffset - metaSize))

  const fd = fs.openSync(destPath, 'w')
  try {
    for (const chunk of chunks) fs.writeSync(fd, chunk, 0, chunk.length)
    if (metaOnly) return dataOffset

    const src = fs.openSync(srcPath, 'r')
    const body = Buffer.alloc(COPY_CHUNK)
    try {
      for (const { tensor, offset } of placed) {
        for (let done = 0; done < tensor.size; done += COPY_CHUNK) {
          const len = Math.min(COPY_CHUNK, tensor.size - done)
          fs.readSync(src, body, 0, len, meta.dataOffset + tensor.offset + done)
          fs.writeSync(fd, body, 0, len, dataOffset + offset + done)
        }
      }
    } finally {
      fs.closeSync(src)
    }
  } finally {
    fs.closeSync(fd)
  }

  return dataOffset
}

/**
 * Truncates a GGUF to its metadata, producing what
 * `gguf_write_to_file(..., only_meta = true)` writes for the same model.
 * @returns {string} destPath
 */
function writeMetaOnly(srcPath, destPath) {
  const { dataOffset } = readGguf(srcPath)
  const buf = Buffer.alloc(dataOffset)
  const fd = fs.openSync(srcPath, 'r')
  try {
    fs.readSync(fd, buf, 0, dataOffset, 0)
  } finally {
    fs.closeSync(fd)
  }
  fs.writeFileSync(destPath, buf)
  return destPath
}

/**
 * Splits a GGUF into `splitCount` shards named the way llama_split_path names
 * them, mirroring gguf-split: the first shard carries the source metadata, the
 * rest carry only the split keys. `metaOnly` drops every data section, which is
 * the sharded form of what only_meta writes.
 * @returns {string[]} shard paths, first shard first
 */
function writeSplit(srcPath, prefix, { splitCount = 2, metaOnly = false } = {}) {
  const meta = readGguf(srcPath)
  const extents = tensorExtents(meta)
  if (extents.length < splitCount) throw new Error('not enough tensors to split')

  const perShard = Math.ceil(extents.length / splitCount)
  const paths = []
  for (let i = 0; i < splitCount; i++) {
    const destPath = splitPath(prefix, i, splitCount)
    writeShard({
      destPath,
      srcPath,
      meta,
      tensors: extents.slice(i * perShard, (i + 1) * perShard),
      nKv: i === 0 ? meta.nKv : 0,
      kvBytes: i === 0 ? meta.kvBytes : null,
      splitNo: i,
      splitCount,
      metaOnly
    })
    paths.push(destPath)
  }
  return paths
}

/** Absolute path of a fixture beside the downloaded test model. */
function fixturePath(name) {
  return path.resolve(__dirname, '../model', name)
}

module.exports = {
  fixturePath,
  readGguf,
  splitPath,
  writeMetaOnly,
  writeSplit
}
