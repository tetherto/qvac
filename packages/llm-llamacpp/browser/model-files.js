// Files handed over for in-place reads, keyed by their mounted path.
const MOUNTED_FILES_KEY = Symbol.for('qvac.browser.mountedFiles')

function shardInfo(name) {
  const match = /^(.*)-(\d+)-of-(\d+)\.gguf$/.exec(name)
  if (!match) return null
  const index = Number(match[2])
  const total = Number(match[3])
  if (!Number.isSafeInteger(index) || !Number.isSafeInteger(total) || index < 1 || total < 1) {
    throw new Error(`Invalid sharded model filename: ${name}`)
  }
  return {
    prefix: match[1],
    index,
    indexWidth: match[2].length,
    total,
    totalText: match[3]
  }
}

function orderedShards(files, expected, path) {
  const shards = files
    .filter(
      (file) =>
        file.name.startsWith(`${expected.prefix}-`) &&
        file.name.endsWith(`-of-${expected.totalText}.gguf`)
    )
    .map((file) => ({ file, shard: shardInfo(file.name) }))
    .filter(
      ({ shard }) =>
        shard &&
        shard.prefix === expected.prefix &&
        shard.indexWidth === expected.indexWidth &&
        shard.totalText === expected.totalText
    )
    .sort((a, b) => a.shard.index - b.shard.index)
  if (
    shards.length !== expected.total ||
    shards.some(({ shard }, position) => shard.index !== position + 1)
  ) {
    throw new Error(
      `Expected ${expected.total} model shards beside ${path}, found ${shards.length}`
    )
  }
  return shards.map(({ file }) => file)
}

// Checks a model path without touching OPFS, so a bad path is rejected before
// the engine starts.
function parseModelPath(path) {
  if (typeof path !== 'string' || !path.startsWith('/')) {
    throw new TypeError(`Expected an absolute OPFS path, got: ${path}`)
  }
  const parts = path.split('/').filter(Boolean)
  const name = parts.pop()
  if (!name) throw new TypeError(`Expected an OPFS file path, got: ${path}`)
  const shard = shardInfo(name)
  if (shard && shard.index !== 1) {
    throw new Error(`A sharded model must be loaded from its first shard: ${path}`)
  }
  return { parts, name, shard }
}

async function modelFiles(path) {
  const { parts, name, shard } = parseModelPath(path)

  const mountedFiles = globalThis[MOUNTED_FILES_KEY]
  const mounted = mountedFiles?.get(path)
  if (mounted) {
    if (!shard) return { primary: mounted, files: [mounted] }
    const parent = path.slice(0, path.lastIndexOf('/') + 1)
    const siblings = []
    for (const [candidatePath, file] of mountedFiles) {
      if (candidatePath.startsWith(parent) && !candidatePath.slice(parent.length).includes('/')) {
        siblings.push(file)
      }
    }
    return { primary: mounted, files: orderedShards(siblings, shard, path) }
  }

  let directory = await navigator.storage.getDirectory()
  for (const part of parts) directory = await directory.getDirectoryHandle(part)
  const primary = await (await directory.getFileHandle(name)).getFile()
  if (!shard) return { primary, files: [primary] }

  const siblings = []
  for await (const [candidateName, handle] of directory.entries()) {
    if (handle.kind !== 'file') continue
    if (
      !candidateName.startsWith(`${shard.prefix}-`) ||
      !candidateName.endsWith(`-of-${shard.totalText}.gguf`)
    ) {
      continue
    }
    const candidate = shardInfo(candidateName)
    if (candidate?.prefix === shard.prefix && candidate.totalText === shard.totalText) {
      siblings.push(await handle.getFile())
    }
  }
  return { primary, files: orderedShards(siblings, shard, path) }
}

const READ_AHEAD_MIN_BYTES = 64 * 1024
const READ_AHEAD_BYTES = 4 * 1024 * 1024
const readAheads = new WeakMap()

// Each WORKERFS read is one FileReaderSync call. Loaders that read in small
// sequential chunks (the projector loader reads ~2 KB at a time) spend most of
// the load in that per-call cost, so a small read that continues the previous
// one is served from a read-ahead window. One window per engine is held, and
// unmounting releases it.
function installReadAhead(module) {
  const ops = module.FS.filesystems.WORKERFS.stream_ops
  if (readAheads.has(ops)) return
  const state = { window: null, lastFile: null, lastEnd: -1, windowBytes: READ_AHEAD_MIN_BYTES }
  readAheads.set(ops, state)
  const read = ops.read
  let reader = null
  ops.read = function (stream, buffer, offset, length, position) {
    const file = stream.node.contents
    const size = stream.node.size
    const window = state.window
    let count
    if (
      window?.file === file &&
      position >= window.start &&
      position + length <= window.start + window.bytes.length
    ) {
      const from = position - window.start
      buffer.set(window.bytes.subarray(from, from + length), offset)
      count = length
    } else if (
      // Any other WORKERFS node layout falls back to emscripten's own read.
      typeof file?.slice === 'function' &&
      length < READ_AHEAD_BYTES &&
      position < size &&
      file === state.lastFile &&
      position === state.lastEnd
    ) {
      // The window doubles while reads stay sequential, so a short run of
      // small reads before a large one fetches little extra.
      if (
        window?.file === file &&
        position > window.start &&
        position <= window.start + window.bytes.length
      ) {
        state.windowBytes = Math.min(state.windowBytes * 2, READ_AHEAD_BYTES)
      } else {
        state.windowBytes = READ_AHEAD_MIN_BYTES
      }
      reader ??= new globalThis.FileReaderSync()
      const end = Math.min(position + Math.max(length, state.windowBytes), size)
      const bytes = new Uint8Array(reader.readAsArrayBuffer(file.slice(position, end)))
      state.window = { file, start: position, bytes }
      count = Math.min(length, bytes.length)
      buffer.set(bytes.subarray(0, count), offset)
    } else {
      count = read.call(this, stream, buffer, offset, length, position)
    }
    state.lastFile = file
    state.lastEnd = position + count
    return count
  }
}

function releaseReadAhead(module) {
  const state = readAheads.get(module.FS.filesystems?.WORKERFS?.stream_ops)
  if (!state) return
  state.window = null
  state.lastFile = null
  state.lastEnd = -1
  state.windowBytes = READ_AHEAD_MIN_BYTES
}

async function mountModelFiles(module, mounts, mountpoint, path) {
  if (!path) return ''
  const { primary, files } = await modelFiles(path)
  installReadAhead(module)
  module.FS.mkdirTree(mountpoint)
  try {
    module.FS.mount(module.FS.filesystems.WORKERFS, { files }, mountpoint)
  } catch (error) {
    try {
      module.FS.rmdir(mountpoint)
    } catch {
      mounts.push({ mountpoint, mounted: false })
    }
    throw error
  }
  mounts.push(mountpoint)
  return `${mountpoint}/${primary.name}`
}

function unmountModelFiles(module, mounts) {
  releaseReadAhead(module)
  const pending = mounts.splice(0)
  let firstError = null
  for (const entry of pending) {
    const state = typeof entry === 'string' ? { mountpoint: entry, mounted: true } : entry
    if (state.mounted) {
      try {
        module.FS.unmount(state.mountpoint)
        state.mounted = false
      } catch (error) {
        mounts.push(state)
        firstError ??= error
        continue
      }
    }
    try {
      module.FS.rmdir(state.mountpoint)
    } catch (error) {
      mounts.push(state)
      firstError ??= error
    }
  }
  if (firstError) throw firstError
}

module.exports = {
  MOUNTED_FILES_KEY,
  installReadAhead,
  modelFiles,
  mountModelFiles,
  orderedShards,
  parseModelPath,
  shardInfo,
  unmountModelFiles
}
