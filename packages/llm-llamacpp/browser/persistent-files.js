'use strict'

const COPY_CHUNK_BYTES = 1024 * 1024
const CHECKPOINT_COMPLETE_FILE = '.qvac-complete'
const CHECKPOINT_COMPLETE_BYTES = Uint8Array.of(81, 86, 65, 67, 1)
const CHECKPOINT_GENERATION_PREFIX = '.qvac-data-'
const CHECKPOINT_GENERATION_VERSION = Uint8Array.of(81, 86, 65, 67, 2)
const pathWrites = new Map()
let nextCheckpointGeneration = 1

function hasOpfs() {
  return typeof navigator !== 'undefined' && typeof navigator.storage?.getDirectory === 'function'
}

function pathParts(path) {
  if (typeof path !== 'string' || path.length === 0 || path.includes('\0')) {
    throw new TypeError(`Invalid OPFS path: ${path}`)
  }
  const parts = path.split('/').filter(Boolean)
  if (parts.length === 0 || parts.some((part) => part === '.' || part === '..')) {
    throw new TypeError(`Invalid OPFS path: ${path}`)
  }
  return parts
}

function canonicalMemfsPath(path) {
  const canonical = pathParts(path).join('/')
  return path.startsWith('/') ? `/${canonical}` : canonical
}

function serializePath(path, task) {
  const lockKey = pathParts(path).join('/')
  if (typeof navigator !== 'undefined' && typeof navigator.locks?.request === 'function') {
    return navigator.locks.request(`qvac-opfs:${lockKey}`, task)
  }
  const previous = pathWrites.get(lockKey) ?? Promise.resolve()
  const result = previous.catch(() => {}).then(task)
  const settled = result
    .catch(() => {})
    .finally(() => {
      if (pathWrites.get(lockKey) === settled) pathWrites.delete(lockKey)
    })
  pathWrites.set(lockKey, settled)
  return result
}

async function parentDirectory(path, create) {
  const parts = pathParts(path)
  const name = parts.pop()
  let directory = await navigator.storage.getDirectory()
  for (const part of parts) {
    directory = await directory.getDirectoryHandle(part, { create })
  }
  return { directory, name }
}

async function opfsFile(path) {
  pathParts(path)
  const mounted = globalThis[Symbol.for('qvac.browser.mountedFiles')]?.get(path)
  if (mounted) return mounted
  if (!hasOpfs()) return null
  try {
    const { directory, name } = await parentDirectory(path, false)
    return await (await directory.getFileHandle(name)).getFile()
  } catch (error) {
    if (error?.name === 'NotFoundError' || error?.name === 'TypeMismatchError') return null
    throw error
  }
}

function ensureMemfsParent(module, path) {
  const slash = path.lastIndexOf('/')
  if (slash > 0) module.FS.mkdirTree(path.slice(0, slash))
}

async function hydrateSource(module, path, source) {
  ensureMemfsParent(module, path)
  const stream = source.stream().getReader()
  let target = null
  let failure = null
  let position = 0
  try {
    target = module.FS.open(path, 'w')
    while (true) {
      const { done, value } = await stream.read()
      if (done) break
      module.FS.write(target, value, 0, value.byteLength, position)
      position += value.byteLength
    }
  } catch (error) {
    failure = error
    if (target) {
      try {
        module.FS.unlink(path)
      } catch {}
    }
    try {
      await stream.cancel(error)
    } catch {}
  } finally {
    try {
      if (target) module.FS.close(target)
    } catch (error) {
      if (!failure) failure = error
    } finally {
      try {
        stream.releaseLock()
      } catch (error) {
        if (!failure) failure = error
      }
    }
  }
  if (failure) throw failure
  return true
}

async function hydrateFile(module, path) {
  const source = await opfsFile(path)
  if (!source) return false
  return hydrateSource(module, path, source)
}

async function hydrateDirectory(module, directory, root, skipInternal = false) {
  module.FS.mkdirTree(root)
  for await (const [name, entry] of directory.entries()) {
    if (
      skipInternal &&
      (name === CHECKPOINT_COMPLETE_FILE || name.startsWith(CHECKPOINT_GENERATION_PREFIX))
    ) {
      continue
    }
    const child = `${root}/${name}`
    if (entry.kind === 'directory') await hydrateDirectory(module, entry, child)
    else await hydrateSource(module, child, await entry.getFile())
  }
}

async function persistFileUnlocked(module, path) {
  if (!hasOpfs()) return false
  const stat = module.FS.stat(path)
  if (!module.FS.isFile(stat.mode)) throw new Error(`Expected a file at ${path}`)
  let source = null
  let writable = null
  let chunk
  let failure = null
  let destinationExisted = null
  let position = 0
  try {
    source = module.FS.open(path, 'r')
    chunk = new Uint8Array(Math.min(COPY_CHUNK_BYTES, Math.max(1, stat.size)))
    const { directory, name } = await parentDirectory(path, true)
    let destination
    destinationExisted = true
    try {
      destination = await directory.getFileHandle(name)
    } catch (error) {
      if (error?.name !== 'NotFoundError') throw error
      destinationExisted = false
      destination = await directory.getFileHandle(name, { create: true })
    }
    writable = await destination.createWritable({ keepExistingData: false })
    while (position < stat.size) {
      const length = Math.min(chunk.byteLength, stat.size - position)
      const read = module.FS.read(source, chunk, 0, length, position)
      if (read <= 0) throw new Error(`Unable to read ${path} at byte ${position}`)
      await writable.write(chunk.subarray(0, read))
      position += read
    }
    await writable.close()
    writable = null
  } catch (error) {
    failure = error
    if (writable) {
      try {
        await writable.abort()
      } catch {}
    }
    if (destinationExisted === false) {
      try {
        const { directory, name } = await parentDirectory(path, false)
        await directory.removeEntry(name)
      } catch {}
    }
  } finally {
    try {
      if (source) module.FS.close(source)
    } catch (error) {
      if (!failure) failure = error
    }
  }
  if (failure) throw failure
  return true
}

function persistFile(module, path) {
  return serializePath(path, () => persistFileUnlocked(module, path))
}

async function persistTree(module, root) {
  if (!hasOpfs()) return false
  let stat
  try {
    stat = module.FS.stat(root)
  } catch (error) {
    if (error?.errno === 44) return false
    throw error
  }
  if (module.FS.isFile(stat.mode)) {
    await persistFile(module, root)
    return true
  }
  if (!module.FS.isDir(stat.mode)) throw new Error(`Unsupported file type at ${root}`)
  for (const name of module.FS.readdir(root)) {
    if (name === '.' || name === '..') continue
    await persistTree(module, `${root}/${name}`)
  }
  return true
}

async function writeCompletionFile(path, bytes = CHECKPOINT_COMPLETE_BYTES) {
  const { directory, name } = await parentDirectory(path, true)
  let destination
  let destinationExisted = true
  try {
    destination = await directory.getFileHandle(name)
  } catch (error) {
    if (error?.name !== 'NotFoundError') throw error
    destinationExisted = false
    destination = await directory.getFileHandle(name, { create: true })
  }
  let writable = null
  try {
    writable = await destination.createWritable({ keepExistingData: false })
    await writable.write(bytes)
    await writable.close()
    writable = null
  } catch (error) {
    if (writable) {
      try {
        await writable.abort()
      } catch {}
    }
    if (!destinationExisted) {
      try {
        await directory.removeEntry(name)
      } catch {}
    }
    throw error
  }
}

function checkpointGenerationName() {
  if (typeof globalThis.crypto?.randomUUID === 'function') {
    return `${CHECKPOINT_GENERATION_PREFIX}${globalThis.crypto.randomUUID()}`
  }
  const sequence = nextCheckpointGeneration++
  const random = Math.random().toString(36).slice(2)
  return `${CHECKPOINT_GENERATION_PREFIX}${Date.now().toString(36)}-${sequence.toString(36)}-${random}`
}

function checkpointMarkerBytes(generation) {
  const name = Uint8Array.from(generation, (character) => character.charCodeAt(0))
  const bytes = new Uint8Array(CHECKPOINT_GENERATION_VERSION.byteLength + name.byteLength)
  bytes.set(CHECKPOINT_GENERATION_VERSION)
  bytes.set(name, CHECKPOINT_GENERATION_VERSION.byteLength)
  return bytes
}

async function persistFileToDirectory(module, sourcePath, directory, name) {
  const stat = module.FS.stat(sourcePath)
  if (!module.FS.isFile(stat.mode)) throw new Error(`Expected a file at ${sourcePath}`)
  const source = module.FS.open(sourcePath, 'r')
  let writable = null
  let failure = null
  try {
    const destination = await directory.getFileHandle(name, { create: true })
    writable = await destination.createWritable({ keepExistingData: false })
    const chunk = new Uint8Array(Math.min(COPY_CHUNK_BYTES, Math.max(1, stat.size)))
    let position = 0
    while (position < stat.size) {
      const length = Math.min(chunk.byteLength, stat.size - position)
      const read = module.FS.read(source, chunk, 0, length, position)
      if (read <= 0) throw new Error(`Unable to read ${sourcePath} at byte ${position}`)
      await writable.write(chunk.subarray(0, read))
      position += read
    }
    await writable.close()
    writable = null
  } catch (error) {
    failure = error
    if (writable) {
      try {
        await writable.abort()
      } catch {}
    }
  } finally {
    try {
      module.FS.close(source)
    } catch (error) {
      if (!failure) failure = error
    }
  }
  if (failure) throw failure
}

async function persistTreeToDirectory(module, sourceRoot, destination) {
  for (const name of module.FS.readdir(sourceRoot)) {
    if (name === '.' || name === '..') continue
    const sourcePath = `${sourceRoot}/${name}`
    const stat = module.FS.stat(sourcePath)
    if (module.FS.isDir(stat.mode)) {
      const child = await destination.getDirectoryHandle(name, { create: true })
      await persistTreeToDirectory(module, sourcePath, child)
    } else if (module.FS.isFile(stat.mode)) {
      await persistFileToDirectory(module, sourcePath, destination, name)
    } else {
      throw new Error(`Unsupported file type at ${sourcePath}`)
    }
  }
}

function persistCompletedTree(module, root) {
  if (!hasOpfs()) return Promise.resolve(false)
  return serializePath(root, async () => {
    let stat
    try {
      stat = module.FS.stat(root)
    } catch (error) {
      if (error?.errno === 44) return false
      throw error
    }
    if (!module.FS.isDir(stat.mode)) throw new Error(`Expected a directory at ${root}`)
    const { directory: parent, name } = await parentDirectory(root, true)
    const directory = await parent.getDirectoryHandle(name, { create: true })
    const generation = checkpointGenerationName()
    const staged = await directory.getDirectoryHandle(generation, { create: true })
    try {
      await persistTreeToDirectory(module, root, staged)
      await writeCompletionFile(
        `${root}/${CHECKPOINT_COMPLETE_FILE}`,
        checkpointMarkerBytes(generation)
      )
    } catch (error) {
      try {
        await directory.removeEntry(generation, { recursive: true })
      } catch {}
      throw error
    }
    for await (const [entryName, entry] of directory.entries()) {
      if (
        entry.kind === 'directory' &&
        entryName.startsWith(CHECKPOINT_GENERATION_PREFIX) &&
        entryName !== generation
      ) {
        try {
          await directory.removeEntry(entryName, { recursive: true })
        } catch {}
      }
    }
    return true
  })
}

async function completionGeneration(directory) {
  try {
    const handle = await directory.getFileHandle(CHECKPOINT_COMPLETE_FILE)
    const file = await handle.getFile()
    const bytes = new Uint8Array(await file.arrayBuffer())
    if (
      bytes.byteLength === CHECKPOINT_COMPLETE_BYTES.byteLength &&
      bytes.every((value, index) => value === CHECKPOINT_COMPLETE_BYTES[index])
    ) {
      return ''
    }
    if (
      bytes.byteLength <= CHECKPOINT_GENERATION_VERSION.byteLength ||
      !CHECKPOINT_GENERATION_VERSION.every((value, index) => value === bytes[index])
    ) {
      return null
    }
    let generation = ''
    for (const byte of bytes.subarray(CHECKPOINT_GENERATION_VERSION.byteLength)) {
      if (byte > 0x7f) return null
      generation += String.fromCharCode(byte)
    }
    if (
      !generation.startsWith(CHECKPOINT_GENERATION_PREFIX) ||
      generation.includes('/') ||
      generation.includes('\0')
    ) {
      return null
    }
    await directory.getDirectoryHandle(generation)
    return generation
  } catch (error) {
    if (error?.name === 'NotFoundError' || error?.name === 'TypeMismatchError') return null
    throw error
  }
}

async function hydrateCheckpointTree(module, root) {
  root = canonicalMemfsPath(root)
  if (!hasOpfs()) return false
  let directory
  try {
    const parent = await parentDirectory(root, false)
    directory = await parent.directory.getDirectoryHandle(parent.name)
  } catch (error) {
    if (error?.name === 'NotFoundError' || error?.name === 'TypeMismatchError') return false
    throw error
  }
  const completed = []
  for await (const [name, entry] of directory.entries()) {
    if (entry.kind !== 'directory') continue
    const generation = await completionGeneration(entry)
    if (generation !== null) completed.push({ name, entry, generation })
  }
  if (completed.length === 0) return true
  removeMemfsTree(module, root)
  module.FS.mkdirTree(root)
  for (const { name, entry, generation } of completed) {
    const source = generation === '' ? entry : await entry.getDirectoryHandle(generation)
    await hydrateDirectory(module, source, `${root}/${name}`, generation === '')
  }
  return true
}

function removeMemoryFile(module, path) {
  path = canonicalMemfsPath(path)
  try {
    const stat = module.FS.stat(path)
    if (!module.FS.isFile(stat.mode)) throw new Error(`Expected a file at ${path}`)
    module.FS.unlink(path)
  } catch (error) {
    if (error?.errno !== 44) throw error
  }
}

function removeMemfsTree(module, path) {
  let stat
  try {
    stat = module.FS.stat(path)
  } catch (error) {
    if (error?.errno === 44) return
    throw error
  }
  if (!module.FS.isDir(stat.mode)) {
    module.FS.unlink(path)
    return
  }
  for (const name of module.FS.readdir(path)) {
    if (name === '.' || name === '..') continue
    removeMemfsTree(module, `${path}/${name}`)
  }
  module.FS.rmdir(path)
}

function removeMemfsMatchingDirectories(module, path, prefix) {
  if (!module) return
  let names
  try {
    names = module.FS.readdir(path)
  } catch (error) {
    if (error?.errno === 44) return
    throw error
  }
  for (const name of names) {
    if (name === '.' || name === '..' || !name.startsWith(prefix)) continue
    const child = `${path}/${name}`
    const stat = module.FS.stat(child)
    if (module.FS.isDir(stat.mode)) removeMemfsTree(module, child)
  }
}

async function removeMatchingDirectories(module, path, prefix) {
  path = canonicalMemfsPath(path)
  removeMemfsMatchingDirectories(module, path, prefix)
  if (!hasOpfs()) return
  const parts = pathParts(path)
  let directory = await navigator.storage.getDirectory()
  try {
    for (const part of parts) directory = await directory.getDirectoryHandle(part)
    for await (const [name, entry] of directory.entries()) {
      if (entry.kind === 'directory' && name.startsWith(prefix)) {
        await directory.removeEntry(name, { recursive: true })
      }
    }
  } catch (error) {
    if (error?.name !== 'NotFoundError') throw error
  }
}

module.exports = {
  CHECKPOINT_COMPLETE_BYTES,
  CHECKPOINT_COMPLETE_FILE,
  hydrateFile,
  hydrateCheckpointTree,
  hasOpfs,
  pathParts,
  persistCompletedTree,
  persistFile,
  persistTree,
  removeMatchingDirectories,
  removeMemoryFile
}
