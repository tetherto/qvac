import test from 'brittle'
import {
  InvalidSeedFromParamsError,
  KvCacheSeedSourceNotFoundError,
  KvCacheSeedToolsMismatchError
} from '@/errors'

// -----------------------------------------------------------------------------
// Seeding a custom-key turn from another named cache. The session copies the
// source file under the target path before the addon runs; the addon then
// loads the copy as the target's own conversation. Pinned here:
//
//   1. A cold target copies the source bytes, records the turn as seeded and as
//      the creator of the file, and leaves the source alone.
//   2. A target that already has a cache ignores `seedFrom`.
//   3. A missing source, including one saved under another system prompt, is
//      refused and leaves no file or directory behind.
//   4. The tool list recorded beside the source must match; a source without a
//      record is accepted.
//   5. A commit records the turn's tool list beside the file; a rollback
//      removes both.
//   6. A seed waits for a turn running on the source and copies what it saved.
//
// Runs under the Bare runtime only (see kv-cache-session.test.ts).
// -----------------------------------------------------------------------------

async function loadSession() {
  const fs = await import('bare-fs')
  const os = await import('bare-os')
  const path = await import('bare-path')
  const { default: env } = await import('bare-env')

  const testHome = fs.mkdtempSync(path.join(os.tmpdir(), 'qvac-kvcache-seed-'))
  env['HOME'] = testHome

  const mod = await import('@/plugins/builtin/llamacpp-completion/ops/kv-cache-session')
  const utils = await import('@/plugins/ops/kv-cache-utils')
  const isolationPath = await utils.getCacheFilePath('_test', '_test', '_test')
  const cacheRoot = path.dirname(path.dirname(path.dirname(isolationPath)))
  fs.rmSync(cacheRoot, { recursive: true, force: true })
  fs.mkdirSync(cacheRoot, { recursive: true })

  mod.__kvCacheSessionTestHooks.resetForTest()

  function cleanup() {
    try {
      fs.rmSync(cacheRoot, { recursive: true, force: true })
      fs.rmSync(testHome, { recursive: true, force: true })
    } catch {
      /* best-effort */
    }
  }

  function writeFakeCache(cachePath: string, bytes = 'fake-kv-cache-bytes') {
    fs.mkdirSync(path.dirname(cachePath), { recursive: true })
    fs.writeFileSync(cachePath, bytes)
  }

  function readText(filePath: string): string {
    return fs.readFileSync(filePath, 'utf8')
  }

  return { fs, path, mod, utils, cleanup, writeFakeCache, readText, cacheRoot }
}

// brittle's matcher wants a no-arg constructor; these errors take arguments.
async function rejectsWith(
  t: { ok: (v: unknown, m?: string) => void; fail: (m?: string) => void },
  promise: Promise<unknown>,
  ctor: new (...args: never[]) => Error,
  message: string
): Promise<void> {
  try {
    await promise
    t.fail(`${message}: resolved`)
  } catch (error) {
    t.ok(
      error instanceof ctor,
      `${message}: ${error instanceof Error ? error.name : String(error)}`
    )
  }
}

const MODEL = 'seed-model'
const SYSTEM = 'you are a helpful assistant.'

test('kv-cache-seed: a cold target starts from a copy of the source and leaves the source alone', async (t) => {
  const { fs, mod, utils, cleanup, writeFakeCache, readText } = await loadSession()
  try {
    const configHash = mod.generateConfigHash(SYSTEM)
    const sourcePath = await utils.getCacheFilePath(MODEL, configHash, 'base')
    writeFakeCache(sourcePath, 'base-bytes')
    await utils.writeToolsSidecar(sourcePath, 'tools-a')

    const session = mod.createKvCacheSession(MODEL)
    const turn = await session.beginTurn({
      kind: 'custom',
      customKey: 'chat-1',
      configHash,
      toolsHash: 'tools-a',
      seedFrom: 'base'
    })
    t.ok(turn.seeded, 'the turn reports the seed')
    t.ok(turn.createdCache, 'the copy counts as a file this turn created')
    t.is(readText(turn.cachePath), 'base-bytes', 'the target holds the source bytes')
    t.absent(
      fs.existsSync(utils.toolsSidecarPath(turn.cachePath)),
      'no tool record before the commit'
    )

    // Stands in for the addon's save at the end of the turn.
    writeFakeCache(turn.cachePath, 'chat-1-bytes')
    await session.commitTurn(turn, { kind: 'static' })
    t.is(readText(sourcePath), 'base-bytes', 'the source is unchanged')
    t.is(
      await utils.readToolsSidecar(turn.cachePath),
      'tools-a',
      'the commit records the tool list'
    )
    t.is(await utils.readToolsSidecar(sourcePath), 'tools-a', "the source's record is unchanged")

    const next = await session.beginTurn({
      kind: 'custom',
      customKey: 'chat-1',
      configHash,
      toolsHash: 'tools-a',
      seedFrom: 'base'
    })
    t.absent(next.seeded, 'a chat that has a cache is not seeded again')
    t.is(readText(next.cachePath), 'chat-1-bytes', 'the later seedFrom does not replace the cache')
    await session.releaseTurn(next)
  } finally {
    cleanup()
  }
})

test('kv-cache-seed: a missing source is refused and leaves nothing behind', async (t) => {
  const { fs, path, mod, utils, cleanup, writeFakeCache } = await loadSession()
  try {
    const configHash = mod.generateConfigHash(SYSTEM)
    const session = mod.createKvCacheSession(MODEL)
    const targetPath = utils.resolveCacheFilePath(MODEL, configHash, 'chat-1')

    await rejectsWith(
      t,

      session.beginTurn({
        kind: 'custom',
        customKey: 'chat-1',
        configHash,
        toolsHash: null,
        seedFrom: 'no-such-base'
      }),
      KvCacheSeedSourceNotFoundError,
      'a source that does not exist is refused'
    )
    t.absent(fs.existsSync(targetPath), 'no target file')
    t.absent(fs.existsSync(path.dirname(targetPath)), 'the target directory is pruned')
    t.absent(
      fs.existsSync(path.dirname(utils.resolveCacheFilePath(MODEL, configHash, 'no-such-base'))),
      'looking up the source created no directory'
    )

    // Same name, other system prompt: a different file, so not a source either.
    const otherHash = mod.generateConfigHash('another system prompt')
    writeFakeCache(await utils.getCacheFilePath(MODEL, otherHash, 'base'))
    await rejectsWith(
      t,

      session.beginTurn({
        kind: 'custom',
        customKey: 'chat-1',
        configHash,
        toolsHash: null,
        seedFrom: 'base'
      }),
      KvCacheSeedSourceNotFoundError,
      'a source saved under another system prompt is refused'
    )

    // The refused turn released its lock: the key is usable afterwards.
    const turn = await session.beginTurn({ kind: 'custom', customKey: 'chat-1', configHash })
    t.absent(turn.seeded)
    await session.releaseTurn(turn)
  } finally {
    cleanup()
  }
})

test('kv-cache-seed: the tool list recorded beside the source has to match', async (t) => {
  const { fs, mod, utils, cleanup, writeFakeCache } = await loadSession()
  try {
    const configHash = mod.generateConfigHash(SYSTEM)
    const sourcePath = await utils.getCacheFilePath(MODEL, configHash, 'base')
    writeFakeCache(sourcePath, 'base-bytes')
    await utils.writeToolsSidecar(sourcePath, 'tools-a')
    const session = mod.createKvCacheSession(MODEL)

    for (const toolsHash of ['tools-b', null]) {
      await rejectsWith(
        t,

        session.beginTurn({
          kind: 'custom',
          customKey: 'chat-1',
          configHash,
          toolsHash,
          seedFrom: 'base'
        }),
        KvCacheSeedToolsMismatchError,
        `a request with ${toolsHash === null ? 'no tools' : 'other tools'} is refused`
      )
    }
    t.absent(fs.existsSync(utils.resolveCacheFilePath(MODEL, configHash, 'chat-1')), 'no copy')

    // A source saved without tools matches a request without tools.
    await utils.writeToolsSidecar(sourcePath, null)
    const plain = await session.beginTurn({
      kind: 'custom',
      customKey: 'chat-2',
      configHash,
      toolsHash: null,
      seedFrom: 'base'
    })
    t.ok(plain.seeded)
    await session.releaseTurn(plain)

    // A source with no record cannot be checked and is accepted.
    await utils.removeToolsSidecar(sourcePath)
    const unchecked = await session.beginTurn({
      kind: 'custom',
      customKey: 'chat-3',
      configHash,
      toolsHash: 'tools-b',
      seedFrom: 'base'
    })
    t.ok(unchecked.seeded, 'a source without a tool record seeds')
    await session.releaseTurn(unchecked)
  } finally {
    cleanup()
  }
})

test('kv-cache-seed: a seeded turn that does not commit removes its copy and its record', async (t) => {
  const { fs, mod, utils, cleanup, writeFakeCache } = await loadSession()
  try {
    const configHash = mod.generateConfigHash(SYSTEM)
    const sourcePath = await utils.getCacheFilePath(MODEL, configHash, 'base')
    writeFakeCache(sourcePath, 'base-bytes')
    const session = mod.createKvCacheSession(MODEL)

    const released = await session.beginTurn({
      kind: 'custom',
      customKey: 'chat-1',
      configHash,
      toolsHash: null,
      seedFrom: 'base'
    })
    t.ok(fs.existsSync(released.cachePath), 'the copy exists during the turn')
    await session.releaseTurn(released)
    t.absent(
      fs.existsSync(released.cachePath),
      'a release of a turn that created the file removes it'
    )

    const committed = await session.beginTurn({
      kind: 'custom',
      customKey: 'chat-1',
      configHash,
      toolsHash: 'tools-a',
      seedFrom: 'base'
    })
    await session.commitTurn(committed, { kind: 'static' })
    t.ok(fs.existsSync(utils.toolsSidecarPath(committed.cachePath)), 'the commit wrote the record')

    const rolledBack = await session.beginTurn({ kind: 'custom', customKey: 'chat-1', configHash })
    await session.rollback(rolledBack)
    t.absent(fs.existsSync(committed.cachePath), 'rollback removes the file')
    t.absent(fs.existsSync(utils.toolsSidecarPath(committed.cachePath)), 'and the record')
    t.ok(fs.existsSync(sourcePath), 'the source is untouched')
  } finally {
    cleanup()
  }
})

test('kv-cache-seed: a seed waits for the turn running on the source and copies what it saved', async (t) => {
  const { mod, utils, cleanup, writeFakeCache, readText } = await loadSession()
  try {
    const configHash = mod.generateConfigHash(SYSTEM)
    const sourcePath = await utils.getCacheFilePath(MODEL, configHash, 'base')
    writeFakeCache(sourcePath, 'base-turn-1')
    const session = mod.createKvCacheSession(MODEL)

    const baseTurn = await session.beginTurn({ kind: 'custom', customKey: 'base', configHash })
    let seeded = false
    const seed = session
      .beginTurn({
        kind: 'custom',
        customKey: 'chat-1',
        configHash,
        toolsHash: null,
        seedFrom: 'base'
      })
      .then((turn) => {
        seeded = true
        return turn
      })
    await new Promise<void>((resolve) => setTimeout(() => resolve(), 20))
    t.absent(seeded, 'the seed waits while a turn holds the source')

    writeFakeCache(sourcePath, 'base-turn-2')
    await session.commitTurn(baseTurn, { kind: 'static' })
    const chatTurn = await seed
    t.ok(chatTurn.seeded)
    t.is(readText(chatTurn.cachePath), 'base-turn-2', 'the copy is the committed state')
    await session.releaseTurn(chatTurn)
  } finally {
    cleanup()
  }
})

test('kv-cache-seed: a source whose key aliases the target does not wait on its own lock', async (t) => {
  const { fs, mod, utils, cleanup, writeFakeCache } = await loadSession()
  try {
    const configHash = mod.generateConfigHash(SYSTEM)
    writeFakeCache(await utils.getCacheFilePath(MODEL, configHash, 'Base'), 'base-bytes')
    const session = mod.createKvCacheSession(MODEL)
    const targetPath = utils.resolveCacheFilePath(MODEL, configHash, 'base')
    // Locks fold case on every platform; the filesystem may or may not.
    const begin = session.beginTurn({
      kind: 'custom',
      customKey: 'base',
      configHash,
      toolsHash: null,
      seedFrom: 'Base'
    })
    if (fs.existsSync(targetPath)) {
      // Case-insensitive filesystem: the target already has a cache, so the seed is ignored.
      const turn = await begin
      t.absent(turn.seeded, 'an aliasing key is the same cache, not a seed')
      await session.releaseTurn(turn)
    } else {
      // Case-sensitive filesystem: a different file under the same lock would deadlock.
      await rejectsWith(t, begin, InvalidSeedFromParamsError, 'an aliasing source is refused')
      const turn = await session.beginTurn({ kind: 'custom', customKey: 'base', configHash })
      await session.releaseTurn(turn)
    }
  } finally {
    cleanup()
  }
})
