import test from 'brittle'
import env from 'bare-env'
import fs from 'bare-fs'
import os from 'bare-os'
import path from 'bare-path'
import tarStream from 'tar-stream'
import Buffer from 'bare-buffer'
import { z } from 'zod'

import { ModelFileNotFoundError } from '@/errors/index'
import { loadModel } from '@/plugins/ops/load-model'
import { registerPlugin, unregisterPlugin } from '@/plugins/registry'
import { isModelLoaded, unregisterModel } from '@/runtime/model-registry'
import { ModelType } from '@/schemas/index'
import type { QvacPlugin } from '@/schemas/plugin'
import { extractAndValidateShardedArchive } from '@/utils/archive'
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

async function writeTar(archivePath: string, entries: Record<string, string>) {
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
  fs.writeFileSync(archivePath, Buffer.concat(chunks))
}

test('extractAndValidateShardedArchive: extracts only the shards and returns the first', async (t) => {
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
  t.is(
    await extractAndValidateShardedArchive(archivePath, extractDir),
    firstShard,
    'an extracted archive is reused'
  )
})

test('extractAndValidateShardedArchive: an interrupted extraction leaves no partial shard', async (t) => {
  const dir = tempDir(t)
  const archivePath = path.join(dir, 'model.tar')
  const extractDir = path.join(dir, 'out')
  await writeTar(archivePath, {
    'model-00001-of-00002.gguf': 'first',
    'model-00002-of-00002.gguf': 'x'.repeat(4096)
  })
  // Cut the archive inside the second shard's data: 512-byte header + 512-byte
  // block for the first shard, 512-byte header for the second, then 1 KiB of data.
  fs.writeFileSync(
    archivePath,
    (fs.readFileSync(archivePath) as Buffer).subarray(0, 512 * 3 + 1024)
  )

  await t.exception(extractAndValidateShardedArchive(archivePath, extractDir))

  t.alike(
    fs.readdirSync(extractDir),
    ['model-00001-of-00002.gguf'],
    'neither the truncated shard nor its partial file is left'
  )
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
  fs.writeFileSync(
    archivePath,
    (fs.readFileSync(archivePath) as Buffer).subarray(0, 512 * 3 + 1024)
  )

  await t.exception(extractAndValidateShardedArchive(archivePath, path.join(dir, 'out')))
})

test('extractAndValidateShardedArchive: a failed rename rejects and removes the partial file', async (t) => {
  const dir = tempDir(t)
  const archivePath = path.join(dir, 'model.tar')
  const extractDir = path.join(dir, 'out')
  await writeTar(archivePath, {
    'model-00001-of-00002.gguf': 'first',
    'model-00002-of-00002.gguf': 'second'
  })
  fs.mkdirSync(path.join(extractDir, 'model-00001-of-00002.gguf'), { recursive: true })
  fs.writeFileSync(path.join(extractDir, 'model-00001-of-00002.gguf', 'blocker'), '')

  await t.exception(extractAndValidateShardedArchive(archivePath, extractDir))

  t.alike(fs.readdirSync(extractDir), ['model-00001-of-00002.gguf'], 'no partial file is left')
})

test('extractAndValidateShardedArchive: concurrent extractions of one archive both succeed', async (t) => {
  const dir = tempDir(t)
  const archivePath = path.join(dir, 'model.tar')
  const extractDir = path.join(dir, 'out')
  const second = 'y'.repeat(1024 * 1024)
  await writeTar(archivePath, {
    'model-00001-of-00002.gguf': 'first',
    'model-00002-of-00002.gguf': second
  })

  const results = await Promise.all([
    extractAndValidateShardedArchive(archivePath, extractDir),
    extractAndValidateShardedArchive(archivePath, extractDir)
  ])

  t.alike(results, [
    path.join(extractDir, 'model-00001-of-00002.gguf'),
    path.join(extractDir, 'model-00001-of-00002.gguf')
  ])
  t.is(fs.readFileSync(path.join(extractDir, 'model-00002-of-00002.gguf'), 'utf8'), second)
  t.alike(fs.readdirSync(extractDir).sort(), [
    '.extraction-complete',
    'model-00001-of-00002.gguf',
    'model-00002-of-00002.gguf'
  ])
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
