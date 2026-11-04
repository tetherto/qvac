import test from 'brittle'
import fs from 'bare-fs'
import os from 'bare-os'
import path from 'bare-path'
import { AbortController } from 'bare-abort-controller'
import { QVACRegistryClient } from '@qvac/registry-client'
import { initEnv } from '@/runtime/env'
import { closeRegistryClient } from '@/runtime/registry-client'
import { downloadSingleFileFromRegistry } from '@/handlers/load-model/registry-download-utils'
import { handleDeleteCache } from '@/handlers/delete-cache'
import {
  getShardedModelCacheDir,
  getSingleFileCachePath,
  getCompanionSetCacheDir
} from '@/utils/cache/paths'
import { generateShortHash } from '@/utils/index'
import { QWEN3_600M_INST_Q4, models } from '@/models/registry/index'
import {
  createRegistryDownloadKey,
  startOrJoinDownload
} from '@/handlers/load-model/download-manager'

type DownloadOptions = { signal?: { aborted: boolean }; clearBlocksOnCancel?: () => boolean }

// Points the cache at a temp home and replaces the client's network methods.
function stubClient(t: ReturnType<typeof test>, methods: Record<string, unknown>) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'qvac-registry-cache-'))
  const argv = Bare.argv.slice()
  Bare.argv.length = 0
  Bare.argv.push('', '', JSON.stringify({ HOME_DIR: home }))
  initEnv()

  const proto = QVACRegistryClient.prototype as unknown as Record<string, unknown>
  const names = ['ready', 'close', ...Object.keys(methods)]
  const original = Object.fromEntries(names.map((name) => [name, proto[name]]))
  proto['ready'] = async () => {}
  proto['close'] = async function (this: { corestore: { close(): Promise<void> } }) {
    await this.corestore.close()
  }
  Object.assign(proto, methods)

  t.teardown(async () => {
    await closeRegistryClient()
    Object.assign(proto, original)
    Bare.argv.length = 0
    Bare.argv.push(...argv)
    initEnv()
    fs.rmSync(home, { recursive: true, force: true })
  })
  return home
}

const binding = {
  coreKey: 'a'.repeat(64),
  blockOffset: 0,
  blockLength: 1,
  byteOffset: 0,
  byteLength: 4,
  sha256: 'b'.repeat(64)
}

test('downloadSingleFileFromRegistry: clearCache reaches the client as clearBlocksOnCancel', async (t) => {
  let clearCache = false
  let seen: boolean | undefined
  const ac = new AbortController()
  const home = stubClient(t, {
    downloadBlob: async (_binding: unknown, opts: DownloadOptions) => {
      // The SDK flags clearCache on the transfer before it aborts.
      clearCache = true
      ac.abort(undefined)
      seen = opts.clearBlocksOnCancel?.()
      throw new Error('Download cancelled')
    }
  })

  await t.exception(
    downloadSingleFileFromRegistry(
      'model.gguf',
      's3',
      path.join(home, 'models', 'model.gguf'),
      'model.gguf',
      'key',
      4,
      '',
      undefined,
      ac.signal,
      binding,
      undefined,
      () => clearCache
    )
  )
  t.is(seen, true, 'client reads clearCache at cancel time')
})

test('deleteCache({ modelSrc }): clears the catalogued blob and deletes the cached file', async (t) => {
  const cleared: unknown[] = []
  stubClient(t, {
    clearBlob: async (blob: unknown) => {
      cleared.push(blob)
    }
  })
  const modelPath = getSingleFileCachePath(QWEN3_600M_INST_Q4.registryPath)
  fs.mkdirSync(path.dirname(modelPath), { recursive: true })
  fs.writeFileSync(modelPath, 'partial')

  const response = await handleDeleteCache({
    type: 'deleteCache',
    modelSrc: QWEN3_600M_INST_Q4.src
  })

  t.is(response.success, true)
  t.alike(
    cleared.map((blob) => (blob as { blockOffset: number }).blockOffset),
    [QWEN3_600M_INST_Q4.blobBlockOffset],
    'cleared the model blob'
  )
  t.absent(fs.existsSync(modelPath), 'cached file deleted')
})

test('deleteCache({ modelSrc }): an uncatalogued model resolves its blob from the registry', async (t) => {
  const cleared: unknown[] = []
  stubClient(t, {
    getModel: async () => ({ blobBinding: binding }),
    clearBlob: async (blob: unknown) => {
      cleared.push(blob)
    }
  })

  const response = await handleDeleteCache({
    type: 'deleteCache',
    modelSrc: 'registry://s3/not/in/catalog.gguf'
  })

  t.is(response.success, true)
  t.alike(cleared, [binding], 'cleared the blob the registry reported')
})

test('deleteCache({ modelSrc }): rejects a source that is not registry://', async (t) => {
  const response = await handleDeleteCache({
    type: 'deleteCache',
    modelSrc: 'https://example.com/m.gguf'
  })
  t.is(response.success, false)
})

test('deleteCache({ modelSrc }): an uncatalogued sharded model clears every shard', async (t) => {
  const cleared: unknown[] = []
  const shard = (n: number) => ({
    path: `x/model-0000${n}-of-00002.gguf`,
    source: 's3',
    blobBinding: { ...binding, blockOffset: n }
  })
  stubClient(t, {
    findModels: async () => [
      shard(1),
      shard(2),
      { path: 'x/model-extra-00001-of-00002.gguf', source: 's3', blobBinding: binding },
      { ...shard(1), source: 'hf' }
    ],
    clearBlob: async (blob: unknown) => {
      cleared.push(blob)
    }
  })
  const registryPath = 'x/model-00001-of-00002.gguf'
  const shardDir = getShardedModelCacheDir(generateShortHash(registryPath))
  fs.writeFileSync(path.join(shardDir, 'model-00001-of-00002.gguf'), 'partial')

  const response = await handleDeleteCache({
    type: 'deleteCache',
    modelSrc: `registry://s3/${registryPath}`
  })

  t.is(response.success, true)
  t.is(cleared.length, 2, "cleared both shards and no other model's")
  t.absent(fs.existsSync(shardDir), 'shard directory deleted')
})

test('deleteCache({ modelSrc }): removes the legacy flat cache of an NMT companion set', async (t) => {
  stubClient(t, { clearBlob: async () => {} })
  const model = models.find((m) => m.name === 'BERGAMOT_AR_EN')!
  const flatFiles = model.companionSet!.files.map((file) =>
    getSingleFileCachePath(file.registryPath)
  )
  for (const file of flatFiles) {
    fs.mkdirSync(path.dirname(file), { recursive: true })
    fs.writeFileSync(file, 'legacy')
  }
  const setDir = getCompanionSetCacheDir(model.companionSet!.setKey)

  const response = await handleDeleteCache({
    type: 'deleteCache',
    modelSrc: `registry://${model.registrySource}/${model.registryPath}`
  })

  t.is(response.success, true)
  t.absent(
    flatFiles.some((file) => fs.existsSync(file)),
    'legacy flat files deleted'
  )
  t.absent(fs.existsSync(setDir), 'companion set directory deleted')
})

test('deleteCache({ modelSrc }): a download of the model is refused while deletion runs', async (t) => {
  let release!: () => void
  let clearing!: () => void
  const started = new Promise<void>((resolve) => (clearing = resolve))
  stubClient(t, {
    clearBlob: () => {
      clearing()
      return new Promise<void>((resolve) => (release = resolve))
    }
  })

  const deletion = handleDeleteCache({ type: 'deleteCache', modelSrc: QWEN3_600M_INST_Q4.src })
  await started

  const key = createRegistryDownloadKey(
    QWEN3_600M_INST_Q4.registrySource,
    QWEN3_600M_INST_Q4.registryPath
  )
  let downloadStarted = false
  const download = startOrJoinDownload(key, async () => {
    downloadStarted = true
    return 'path'
  })
  await t.exception(download.promise, /being deleted/)
  t.absent(downloadStarted, 'download did not start')

  release()
  t.is((await deletion).success, true)
})

test('deleteCache({ modelSrc }): a download of the same path from another source is refused', async (t) => {
  let release!: () => void
  let clearing!: () => void
  const started = new Promise<void>((resolve) => (clearing = resolve))
  stubClient(t, {
    getModel: async () => ({ blobBinding: binding }),
    clearBlob: () => {
      clearing()
      return new Promise<void>((resolve) => (release = resolve))
    }
  })

  const deletion = handleDeleteCache({
    type: 'deleteCache',
    modelSrc: 'registry://s3/review/shared-model.gguf'
  })
  await started

  let downloadStarted = false
  const download = startOrJoinDownload(
    createRegistryDownloadKey('hf', 'review/shared-model.gguf'),
    async () => {
      downloadStarted = true
      return 'path'
    }
  )
  await t.exception(download.promise, /being deleted/)
  t.absent(downloadStarted, 'download did not start')

  release()
  t.is((await deletion).success, true)
})

test('deleteCache({ modelSrc }): refused while another source downloads the same path', async (t) => {
  stubClient(t, {})
  let finish!: () => void
  const download = startOrJoinDownload(
    createRegistryDownloadKey('hf', 'review/active-model.gguf'),
    () => new Promise<string>((resolve) => (finish = () => resolve('path')))
  )

  const response = await handleDeleteCache({
    type: 'deleteCache',
    modelSrc: 'registry://s3/review/active-model.gguf'
  })
  t.is(response.success, false)
  t.ok(response.error?.includes('downloading'), 'reports the active download')

  finish()
  await download.promise
})
