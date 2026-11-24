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

async function modelFiles(path) {
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

module.exports = { MOUNTED_FILES_KEY, modelFiles, orderedShards, shardInfo }
