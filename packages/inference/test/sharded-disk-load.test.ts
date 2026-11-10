import test from 'brittle'
import env from 'bare-env'
import fs from 'bare-fs'
import os from 'bare-os'
import path from 'bare-path'
import tarStream from 'tar-stream'
import { AbortController } from 'bare-abort-controller'
import Buffer from 'bare-buffer'
import { z } from 'zod'

import { DownloadCancelledError, ModelFileNotFoundError } from '@/errors/index'
import { loadModel } from '@/plugins/ops/load-model'
import { registerPlugin, unregisterPlugin } from '@/plugins/registry'
import { isModelLoaded, unregisterModel } from '@/runtime/model-registry'
import { ModelType } from '@/schemas/index'
import type { QvacPlugin } from '@/schemas/plugin'
import {
  extractAndValidateShardedArchive,
  extractTarStream,
  isShardedExtractionComplete
} from '@/utils/archive'
import { checkAllShardsExist } from '@/utils/shard-utils'
import { selectDeclaredShards } from '@/handlers/load-model/registry'

env['HOME'] = path.join(os.tmpdir(), `qvac-sharded-disk-load-${os.pid()}`)

function tempDir(t: { teardown: (fn: () => void) => void }) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'qvac-sharded-disk-load-'))
  t.teardown(() => fs.rmSync(dir, { recursive: true, force: true }))
  return dir
}

function registerRecordingPlugin(t: { teardown: (fn: () => void) => void }) {
  const created: string[] = []
  const plugin = {
    modelType: ModelType.llamacppCompletion,
    displayName: 'Sharded disk load',
    addonPackage: '@qvac/llm-llamacpp',
    loadConfigSchema: z.looseObject({}),
    createModel: (params: { modelPath: string }) => {
      created.push(params.modelPath)
      return { model: { load: async () => {}, unload: async () => {} } }
    },
    handlers: {}
  } as unknown as QvacPlugin
  registerPlugin(plugin)
  t.teardown(() => unregisterPlugin(plugin.modelType))
  return created
}

function load(modelId: string, modelPath: string) {
  return loadModel({
    modelId,
    modelPath,
    options: {
      type: 'loadModel',
      modelSrc: modelPath,
      modelType: ModelType.llamacppCompletion,
      modelConfig: {}
    }
  } as never)
}

test('loadModel: a sharded model loads with only its shards on disk', async (t) => {
  const created = registerRecordingPlugin(t)
  const dir = tempDir(t)
  fs.writeFileSync(path.join(dir, 'model-00001-of-00002.gguf'), '')
  fs.writeFileSync(path.join(dir, 'model-00002-of-00002.gguf'), '')
  const modelPath = path.join(dir, 'model-00001-of-00002.gguf')

  await load('sharded-disk-only', modelPath)
  t.teardown(() => unregisterModel('sharded-disk-only'))

  t.alike(created, [modelPath])
  t.ok(isModelLoaded('sharded-disk-only'))
  t.absent(fs.existsSync(path.join(dir, 'model.tensors.txt')), 'no tensors.txt is written')
})

test('loadModel: a sharded model with a missing shard is rejected', async (t) => {
  const created = registerRecordingPlugin(t)
  const dir = tempDir(t)
  fs.writeFileSync(path.join(dir, 'model-00001-of-00002.gguf'), '')
  fs.writeFileSync(path.join(dir, 'model.tensors.txt'), 'token_embd.weight\n')

  let thrown: unknown
  try {
    await load('sharded-missing-shard', path.join(dir, 'model-00001-of-00002.gguf'))
  } catch (error) {
    thrown = error
  }

  t.ok(thrown instanceof ModelFileNotFoundError)
  t.ok((thrown as Error).message.includes('Missing shards. Expected 2 shard files'))
  t.is(created.length, 0, 'the addon never loads')
})

test('loadModel: a filename claiming 99999 shards is rejected without loading', async (t) => {
  const created = registerRecordingPlugin(t)
  const dir = tempDir(t)
  fs.writeFileSync(path.join(dir, 'model-00001-of-99999.gguf'), '')

  let thrown: unknown
  try {
    await load('sharded-oversized-count', path.join(dir, 'model-00001-of-99999.gguf'))
  } catch (error) {
    thrown = error
  }

  t.ok(thrown instanceof ModelFileNotFoundError)
  t.ok((thrown as Error).message.includes('Missing shards. Expected 99999 shard files'))
  t.is(created.length, 0, 'the addon never loads')
})

test('checkAllShardsExist: a gap in the middle of the group is reported', async (t) => {
  const dir = tempDir(t)
  fs.writeFileSync(path.join(dir, 'model-00001-of-00003.gguf'), '')
  fs.writeFileSync(path.join(dir, 'model-00003-of-00003.gguf'), '')
  t.is(await checkAllShardsExist(dir, 'model-00001-of-00003.gguf'), false)
  fs.writeFileSync(path.join(dir, 'model-00002-of-00003.gguf'), '')
  t.is(await checkAllShardsExist(dir, 'model-00003-of-00003.gguf'), true)
})

async function writeTar(
  archivePath: string,
  entries: Record<string, string>,
  { endBlocks = true } = {}
) {
  const pack = tarStream.pack()
  const chunks: Buffer[] = []
  const done = new Promise<void>((resolve, reject) => {
    pack.on('data', (chunk) => chunks.push(chunk as Buffer))
    pack.on('end', () => resolve())
    pack.on('error', (error) => reject(error))
  })
  for (const [name, content] of Object.entries(entries)) pack.entry({ name }, content)
  pack.finalize()
  await done
  const tar = Buffer.concat(chunks)
  // The end of a tar is two 512-byte zero blocks, which some writers omit.
  fs.writeFileSync(archivePath, endBlocks ? tar : tar.subarray(0, tar.length - 1024))
}

function truncateTar(archivePath: string, length: number) {
  fs.writeFileSync(archivePath, (fs.readFileSync(archivePath) as Buffer).subarray(0, length))
}

function leftovers(extractDir: string) {
  return fs.readdirSync(extractDir).filter((f) => !f.endsWith('.gguf'))
}

// Stream and filesystem ordering bugs are intermittent, so the extraction
// tests below repeat each scenario.
const RUNS = 25

test('extractAndValidateShardedArchive: extracts the shards and reuses them without the archive', async (t) => {
  const dir = tempDir(t)
  const archivePath = path.join(dir, 'model.tar')
  const extractDir = path.join(dir, 'out')
  await writeTar(archivePath, {
    'model-00001-of-00002.gguf': 'a',
    'model-00002-of-00002.gguf': 'b',
    'model.tensors.txt': 'token_embd.weight\n'
  })

  const firstShard = await extractAndValidateShardedArchive(archivePath, extractDir)

  t.is(firstShard, path.join(extractDir, 'model-00001-of-00002.gguf'))
  t.alike(fs.readdirSync(extractDir).sort(), [
    '.extraction-complete',
    'model-00001-of-00002.gguf',
    'model-00002-of-00002.gguf'
  ])
  fs.rmSync(archivePath)
  t.is(
    await extractAndValidateShardedArchive(archivePath, extractDir),
    firstShard,
    'a completed extraction is reused without reading the archive'
  )
})

test('extractAndValidateShardedArchive: an archive without end-of-archive blocks extracts every shard', async (t) => {
  // Odd sizes leave the last entry padded, and a payload that ends on a read
  // chunk boundary leaves its padding to a later chunk.
  const sizes = [1, 511, 513, 64 * 1024 - 1, 64 * 1024 + 1, 128 * 1024 - 512 - 7, 256 * 1024 + 3]
  for (let run = 0; run < RUNS * sizes.length; run++) {
    const second = 'z'.repeat(sizes[run % sizes.length]!)
    const dir = tempDir(t)
    const archivePath = path.join(dir, 'model.tar')
    const extractDir = path.join(dir, 'out')
    await writeTar(
      archivePath,
      { 'model-00001-of-00002.gguf': 'first', 'model-00002-of-00002.gguf': second },
      { endBlocks: false }
    )

    await extractAndValidateShardedArchive(archivePath, extractDir)

    t.is(fs.readFileSync(path.join(extractDir, 'model-00002-of-00002.gguf'), 'utf8'), second)
  }
})

test('extractTarStream: every byte is written when it resolves, without end-of-archive blocks', async (t) => {
  const sizes = [1, 511, 513, 64 * 1024 - 1, 64 * 1024 + 1, 128 * 1024 - 512 - 7, 256 * 1024 + 3]
  for (let run = 0; run < RUNS * sizes.length; run++) {
    const second = 'z'.repeat(sizes[run % sizes.length]!)
    const dir = tempDir(t)
    const archivePath = path.join(dir, 'model.tar')
    const extractDir = path.join(dir, 'out')
    await writeTar(
      archivePath,
      { 'model-00001-of-00002.gguf': 'first', 'model-00002-of-00002.gguf': second },
      { endBlocks: false }
    )

    await extractTarStream(archivePath, extractDir, false)

    // Checked synchronously at resolve time, before anything else can run.
    const shard = path.join(extractDir, 'model-00002-of-00002.gguf')
    t.is(fs.existsSync(shard) ? fs.statSync(shard).size : -1, second.length)
  }
})

test(
  'extractTarStream: a write that fails after the archive ends rejects',
  { skip: os.platform() !== 'linux' },
  async (t) => {
    for (let run = 0; run < RUNS; run++) {
      const dir = tempDir(t)
      const archivePath = path.join(dir, 'model.tar')
      const extractDir = path.join(dir, 'out')
      await writeTar(
        archivePath,
        {
          'model-00001-of-00002.gguf': 'first',
          'model-00002-of-00002.gguf': 'z'.repeat(64 * 1024 + 1)
        },
        { endBlocks: false }
      )
      fs.mkdirSync(extractDir)
      // Every write to /dev/full fails with ENOSPC.
      fs.symlinkSync('/dev/full', path.join(extractDir, 'model-00002-of-00002.gguf'))

      await t.exception(extractTarStream(archivePath, extractDir, false))
    }
  }
)

test('extractTarStream: an already-cancelled signal rejects before reading the archive', async (t) => {
  const dir = tempDir(t)
  const archivePath = path.join(dir, 'model.tar')
  await writeTar(archivePath, { 'model-00001-of-00001.gguf': 'only' })
  const controller = new AbortController()
  controller.abort(undefined)

  let thrown: unknown
  try {
    await extractTarStream(archivePath, path.join(dir, 'out'), false, controller.signal)
  } catch (error) {
    thrown = error
  }

  t.ok(thrown instanceof DownloadCancelledError)
  t.absent(fs.existsSync(path.join(dir, 'out', 'model-00001-of-00001.gguf')))
})

test('extractAndValidateShardedArchive: an interrupted extraction is not marked complete', async (t) => {
  for (let run = 0; run < RUNS; run++) {
    const dir = tempDir(t)
    const archivePath = path.join(dir, 'model.tar')
    const extractDir = path.join(dir, 'out')
    const entries = {
      'model-00001-of-00002.gguf': 'first',
      'model-00002-of-00002.gguf': 'x'.repeat(4096)
    }
    await writeTar(archivePath, entries)
    // Cut inside the second shard's data: header + block for the first shard,
    // header for the second, then 1 KiB of its data.
    truncateTar(archivePath, 512 * 3 + 1024)

    await t.exception(extractAndValidateShardedArchive(archivePath, extractDir))
    t.alike(leftovers(extractDir), [], 'no completion marker is left')

    await writeTar(archivePath, entries)
    await extractAndValidateShardedArchive(archivePath, extractDir)
    t.is(
      fs.readFileSync(path.join(extractDir, 'model-00002-of-00002.gguf'), 'utf8'),
      entries['model-00002-of-00002.gguf'],
      'the next load extracts the archive again'
    )
  }
})

test('extractAndValidateShardedArchive: an archive cut inside a skipped entry rejects', async (t) => {
  const dir = tempDir(t)
  const archivePath = path.join(dir, 'model.tar')
  await writeTar(archivePath, {
    'model-00001-of-00002.gguf': 'first',
    'model.tensors.txt': 'x'.repeat(4096),
    'model-00002-of-00002.gguf': 'second'
  })
  // Cut inside model.tensors.txt, which extraction skips.
  truncateTar(archivePath, 512 * 3 + 1024)

  await t.exception(extractAndValidateShardedArchive(archivePath, path.join(dir, 'out')))
})

test('extractAndValidateShardedArchive: a failed write rejects and is not marked complete', async (t) => {
  for (let run = 0; run < RUNS; run++) {
    const dir = tempDir(t)
    const archivePath = path.join(dir, 'model.tar')
    const extractDir = path.join(dir, 'out')
    await writeTar(archivePath, {
      'model-00001-of-00002.gguf': 'first',
      'model-00002-of-00002.gguf': 'second'
    })
    fs.mkdirSync(path.join(extractDir, 'model-00002-of-00002.gguf'), { recursive: true })

    await t.exception(extractAndValidateShardedArchive(archivePath, extractDir))
    t.alike(leftovers(extractDir), [], 'no completion marker is left')
  }
})

test('extractAndValidateShardedArchive: concurrent extractions of one archive both succeed', async (t) => {
  const second = 'y'.repeat(1024 * 1024)
  for (let run = 0; run < RUNS; run++) {
    const dir = tempDir(t)
    const archivePath = path.join(dir, 'model.tar')
    const extractDir = path.join(dir, 'out')
    await writeTar(archivePath, {
      'model-00001-of-00002.gguf': 'first',
      'model-00002-of-00002.gguf': second
    })

    const first = extractAndValidateShardedArchive(archivePath, extractDir)
    const joined = extractAndValidateShardedArchive(archivePath, extractDir)
    t.is(first, joined, 'the second caller joins the first extraction')
    const results = await Promise.all([first, joined])

    t.alike(results, [
      path.join(extractDir, 'model-00001-of-00002.gguf'),
      path.join(extractDir, 'model-00001-of-00002.gguf')
    ])
    t.is(fs.readFileSync(path.join(extractDir, 'model-00002-of-00002.gguf'), 'utf8'), second)
    t.alike(leftovers(extractDir), ['.extraction-complete'])
  }
})

async function seedExtraction(t: { teardown: (fn: () => void) => void }) {
  const dir = tempDir(t)
  const archivePath = path.join(dir, 'model.tar')
  const extractDir = path.join(dir, 'out')
  await writeTar(archivePath, {
    'model-00001-of-00002.gguf': 'first',
    'model-00002-of-00002.gguf': 'second'
  })
  // All shard names present, the last one truncated, as an extraction
  // interrupted by an earlier SDK version leaves it.
  fs.mkdirSync(extractDir)
  fs.writeFileSync(path.join(extractDir, 'model-00001-of-00002.gguf'), 'first')
  fs.writeFileSync(path.join(extractDir, 'model-00002-of-00002.gguf'), 'se')
  return { archivePath, extractDir }
}

test('extractAndValidateShardedArchive: shards without a completion marker are extracted again', async (t) => {
  const { archivePath, extractDir } = await seedExtraction(t)

  await extractAndValidateShardedArchive(archivePath, extractDir)

  t.is(fs.readFileSync(path.join(extractDir, 'model-00002-of-00002.gguf'), 'utf8'), 'second')
  t.ok(fs.existsSync(path.join(extractDir, '.extraction-complete')))
})

test('extractAndValidateShardedArchive: an earlier SDK cache with tensors.txt is extracted again', async (t) => {
  const { archivePath, extractDir } = await seedExtraction(t)
  // Earlier SDKs could write tensors.txt over an interrupted extraction, so it
  // does not prove the shards are complete.
  fs.writeFileSync(path.join(extractDir, 'model.tensors.txt'), 'token_embd.weight\n')

  await extractAndValidateShardedArchive(archivePath, extractDir)

  t.is(fs.readFileSync(path.join(extractDir, 'model-00002-of-00002.gguf'), 'utf8'), 'second')
})

function registryShard(name: string) {
  return { path: `qvac_models_compiled/ggml/m/2026-01-01/${name}` }
}

test('selectDeclaredShards: keeps exactly the shards the filename declares', (t) => {
  const listing = [
    registryShard('model-00001-of-00002.gguf'),
    registryShard('model-00002-of-00002.gguf'),
    registryShard('model-00001-of-00003.gguf')
  ]
  t.alike(
    selectDeclaredShards(
      'qvac_models_compiled/ggml/m/2026-01-01/model-00001-of-00002.gguf',
      listing
    ),
    listing.slice(0, 2)
  )
})

test('selectDeclaredShards: returns the shards in order and ignores other directories', (t) => {
  const listing = [
    registryShard('model-00002-of-00002.gguf'),
    { path: 'qvac_models_compiled/ggml/m/2026-01-01/x/model-00002-of-00002.gguf' },
    registryShard('model-00001-of-00002.gguf')
  ]
  t.alike(
    selectDeclaredShards(
      'qvac_models_compiled/ggml/m/2026-01-01/model-00002-of-00002.gguf',
      listing
    ),
    [listing[2], listing[0]]
  )
})

test('selectDeclaredShards: a shard missing from the registry fails the download', (t) => {
  t.exception(
    () =>
      selectDeclaredShards('qvac_models_compiled/ggml/m/2026-01-01/model-00001-of-00003.gguf', [
        registryShard('model-00001-of-00003.gguf'),
        registryShard('model-00003-of-00003.gguf')
      ]),
    /Expected 3 shards .* but the registry has 2/
  )
})

test('extractAndValidateShardedArchive: a failed re-extraction leaves the cache incomplete', async (t) => {
  for (let run = 0; run < RUNS; run++) {
    const dir = tempDir(t)
    const archivePath = path.join(dir, 'model.tar')
    const extractDir = path.join(dir, 'out')
    const entries = {
      'model-00001-of-00002.gguf': 'first',
      'model-00002-of-00002.gguf': 'x'.repeat(4096)
    }
    await writeTar(archivePath, entries)
    await extractAndValidateShardedArchive(archivePath, extractDir)
    // A shard goes missing, and the archive is cut inside the second shard.
    fs.rmSync(path.join(extractDir, 'model-00001-of-00002.gguf'))
    truncateTar(archivePath, 512 * 3 + 1024)

    await t.exception(extractAndValidateShardedArchive(archivePath, extractDir))
    t.is(await isShardedExtractionComplete(extractDir, 'model-00001-of-00002.gguf'), false)
  }
})
