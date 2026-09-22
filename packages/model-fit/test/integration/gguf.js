'use strict'

// Builds the fit-stub fixtures the tests compare against, from whatever real
// model the suite already downloaded.
//
// A fit stub is the short GGUF the registry serves for a fit: the header, the
// hyperparameters and the tensor infos, with the tokenizer tables dropped and
// nothing after the header — tens of KB in place of the artefact. The tensor
// offsets describe the artefact's layout, so they run far past the stub's EOF.
//
// Two things make it loadable. qvac-fabric 10549.0.0 skips the file-bounds
// check under no_alloc, which is what lets the data section be absent rather
// than padded out. It does not skip the vocab load, so the tokenizer keys
// cannot all go: `tokenizer.ggml.model = none` is what takes that load to its
// early return, and the vocabulary size has to survive as `{arch}.vocab_size`.
// BERT-family models need `tokenizer.ggml.token_type_count` on top.

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

// Where the vocabulary size is read from when `{arch}.vocab_size` is absent,
// in the registry's order. Both are [n_embd, n_vocab].
const VOCAB_TENSORS = ['token_embd.weight', 'output.weight']

const TOKENIZER_MODEL = 'tokenizer.ggml.model'
const TOKEN_TYPE_COUNT = 'tokenizer.ggml.token_type_count'

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

// Walks past a value without decoding it. Values the fixtures read back are
// decoded from the recorded offset instead; the rest are copied as raw bytes.
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

  const kvs = []
  let alignment = DEFAULT_ALIGNMENT
  for (let i = 0; i < nKv; i++) {
    const start = cur.offset
    const key = cur.str()
    const type = cur.u32()
    const valueAt = cur.offset
    skipValue(cur, type)
    const entry = { key, type, start, end: cur.offset }
    if (type === TYPE.UINT32) entry.value = buf.readUInt32LE(valueAt)
    else if (type === TYPE.INT32) entry.value = buf.readInt32LE(valueAt)
    else if (type === TYPE.STRING) entry.value = buf.toString('utf8', valueAt + 8, cur.offset)
    kvs.push(entry)
    if (key === 'general.alignment' && type === TYPE.UINT32) alignment = entry.value
  }

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

  return { version, kvs, tensors, alignment, dataOffset: pad(cur.offset, alignment) }
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
        return { ...parseMetadata(buf), buf, fileSize }
      } catch (err) {
        if (!(err instanceof RangeError) || size === fileSize) throw err
      }
    }
  } finally {
    fs.closeSync(fd)
  }
}

function kvValue(meta, key) {
  const entry = meta.kvs.find((kv) => kv.key === key)
  return entry === undefined ? undefined : entry.value
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
  if (type === TYPE.STRING) {
    writeString(chunks, value)
    return
  }
  const body = Buffer.alloc(SCALAR_SIZE[type])
  if (type === TYPE.UINT16) body.writeUInt16LE(value)
  else if (type === TYPE.UINT32) body.writeUInt32LE(value)
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

// llama reads the vocabulary size from `{arch}.vocab_size` and otherwise falls
// back to the token list a stub drops, so an absent key has to be synthesised —
// token_embd.weight is [n_embd, n_vocab]. Architectures with no token embedding
// (vision towers, codecs, ASR) have no vocabulary to declare, and the registry
// omits the key there too.
function vocabSize(meta) {
  for (const name of VOCAB_TENSORS) {
    const tensor = meta.tensors.find((t) => t.name === name)
    if (tensor !== undefined && tensor.dims.length >= 2) return tensor.dims[1]
  }
  return undefined
}

// The KV block of a stub: everything the source declares except the tokenizer
// tables, with the keys the vocab load still needs forced to the values that
// take it to its early return. A shard past the first declares no tokenizer of
// its own, so it gains nothing here either.
function stubKvs(meta, { includeSource = true } = {}) {
  const kept = []

  if (includeSource) {
    for (const kv of meta.kvs) {
      if (!kv.key.startsWith('tokenizer.')) kept.push({ raw: kv })
      else if (kv.key === TOKEN_TYPE_COUNT) kept.push({ raw: kv })
    }

    // No architecture means no `{arch}.vocab_size` to restate.
    const arch = kvValue(meta, 'general.architecture')
    if (typeof arch === 'string' && kvValue(meta, `${arch}.vocab_size`) === undefined) {
      const vocab = vocabSize(meta)
      if (vocab !== undefined) {
        kept.push({ key: `${arch}.vocab_size`, type: TYPE.UINT32, value: vocab })
      }
    }
  }

  // Unconditional, on every shard and on a source that never had a tokenizer at
  // all (an mmproj, say): absent the key the loader has no vocabulary
  // implementation to pick and refuses the file. Ingest writes it the same way.
  kept.push({ key: TOKENIZER_MODEL, type: TYPE.STRING, value: 'none' })
  return kept
}

function writeGguf({ destPath, srcPath, meta, kvs, tensors, writeData }) {
  const chunks = []

  const header = Buffer.alloc(4 + 4 + 8 + 8)
  header.write(MAGIC, 0, 'ascii')
  header.writeUInt32LE(meta.version, 4)
  header.writeBigUInt64LE(BigInt(tensors.length), 8)
  header.writeBigUInt64LE(BigInt(kvs.length), 16)
  chunks.push(header)

  for (const kv of kvs) {
    if (kv.raw) chunks.push(meta.buf.subarray(kv.raw.start, kv.raw.end))
    else writeKv(chunks, kv.key, kv.type, kv.value)
  }

  // gguf_init rejects a tensor whose offset is not exactly where the previous
  // one ended, so every file numbers its own data section from 0 — including a
  // stub, whose offsets then run far past its EOF. For a whole-model stub this
  // reproduces the source offsets, the extents being the source layout.
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
    if (!writeData) return destPath

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

  return destPath
}

function shardTensors(meta, splitCount) {
  const extents = tensorExtents(meta)
  if (extents.length < splitCount) throw new Error('not enough tensors to split')
  const perShard = Math.ceil(extents.length / splitCount)
  return Array.from({ length: splitCount }, (_, i) =>
    extents.slice(i * perShard, (i + 1) * perShard)
  )
}

function splitKvs(meta, { splitNo, splitCount }) {
  return [
    { key: 'split.no', type: TYPE.UINT16, value: splitNo },
    { key: 'split.count', type: TYPE.UINT16, value: splitCount },
    { key: 'split.tensors.count', type: TYPE.INT32, value: meta.tensors.length }
  ]
}

/**
 * Writes the fit stub for a GGUF: the shape the registry serves — no tokenizer
 * tables, `tokenizer.ggml.model = none`, no data section.
 * @returns {string} destPath
 */
function writeFitStub(srcPath, destPath) {
  const meta = readGguf(srcPath)
  return writeGguf({
    destPath,
    meta,
    kvs: stubKvs(meta),
    tensors: tensorExtents(meta),
    writeData: false
  })
}

/**
 * Splits a GGUF into `splitCount` shards named the way llama_split_path names
 * them, mirroring gguf-split: the first shard carries the source metadata, the
 * rest carry only the split keys. `stub` writes each shard as a fit stub.
 * @returns {string[]} shard paths, first shard first
 */
function writeSplit(srcPath, prefix, { splitCount = 2, stub = false } = {}) {
  const meta = readGguf(srcPath)
  const shards = shardTensors(meta, splitCount)

  return shards.map((tensors, i) => {
    const source = stub ? stubKvs(meta, { includeSource: i === 0 }) : i === 0 ? allKvs(meta) : []
    return writeGguf({
      destPath: splitPath(prefix, i, splitCount),
      srcPath,
      meta,
      kvs: [...source, ...splitKvs(meta, { splitNo: i, splitCount })],
      tensors,
      writeData: !stub
    })
  })
}

function allKvs(meta) {
  return meta.kvs.map((raw) => ({ raw }))
}

/** Directory the fixtures are written to, beside the downloaded test model. */
function fixtureDir() {
  return path.resolve(__dirname, '../model')
}

/** Absolute path of a fixture beside the downloaded test model. */
function fixturePath(name) {
  return path.join(fixtureDir(), name)
}

module.exports = {
  fixtureDir,
  fixturePath,
  kvValue,
  readGguf,
  writeFitStub,
  writeSplit
}
