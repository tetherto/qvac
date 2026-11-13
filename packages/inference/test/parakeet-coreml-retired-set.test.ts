import test from 'brittle'
import fs from 'bare-fs'
import os from 'bare-os'
import path from 'bare-path'

import { models, type RegistryItem } from '@/models/registry/models'
import {
  clearRetiredCoremlSet,
  findCatalogCoremlCompanionSet,
  getCoremlSetKey,
  getRetiredCoremlSetDir,
  linkAwayFromCoremlBundles,
  readRetiredCoremlCompanionSet
} from '@/handlers/load-model/coreml-sidecars'
import {
  getCoremlSidecarSpec,
  getModelCacheLayout,
  getRetiredCoremlSidecarSpec
} from '@/utils/cache/layout'
import { downloadModelFromRegistry } from '@/handlers/load-model/registry'
import { getRuntimeContext } from '@/runtime/state'
import { getSingleFileCachePath } from '@/utils/cache/paths'
import { measureChecksum } from '@/utils/checksum'
import { generateShortHash } from '@/utils/formatting'
import { isPathWithinBase } from '@/utils/path-security'
import { holdStore, makeTempHome, useRegistryHome } from './fixtures/registry-store'
import { useTestCacheDir } from './fixtures/test-cache'

const TDT_V3 = 'parakeet-tdt-0.6b-v3'
const UNIFIED = 'parakeet-unified-en-0.6b'
const ENCODER_ROOT = 'qvac_models_compiled/ggml/parakeet/2026-09-28/'

function catalogModel(filename: string): RegistryItem {
  const model = models.find((entry) => entry.registryPath.endsWith(`/${filename}`))
  if (!model) throw new Error(`${filename} is not in the catalog`)
  return model
}

/** The set directory an earlier release staged: the GGUF and its encoder bundle. */
function stageRetiredSet(cacheDir: string, model: RegistryItem): string {
  const setDir = getRetiredCoremlSetDir(model, 'darwin', cacheDir)!
  const filename = model.registryPath.split('/').pop()!
  fs.mkdirSync(path.join(setDir, `${TDT_V3}-encoder.mlmodelc`, 'weights'), { recursive: true })
  fs.writeFileSync(path.join(setDir, filename), 'gguf')
  fs.writeFileSync(path.join(setDir, `${TDT_V3}-encoder.mlmodelc`, 'weights', 'weight.bin'), 'w')
  return setDir
}

function tempCache(t: { teardown: (fn: () => void) => void }): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'qvac-retired-coreml-'))
  t.teardown(() => fs.rmSync(dir, { recursive: true, force: true }))
  return dir
}

// The bytes `stageRetiredSet` writes as the GGUF, and their SHA-256.
const GGUF = 'gguf'
let ggufChecksum: string | undefined
async function stagedGgufChecksum(): Promise<string> {
  if (ggufChecksum === undefined) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'qvac-retired-sum-'))
    try {
      fs.writeFileSync(path.join(dir, 'model.gguf'), GGUF)
      ggufChecksum = await measureChecksum(path.join(dir, 'model.gguf'))
    } finally {
      fs.rmSync(dir, { recursive: true, force: true })
    }
  }
  return ggufChecksum
}

/** The catalog TDT v3 entry, expecting the size and checksum of the staged GGUF. */
async function stagedModel(filename: string, registryPath?: string): Promise<RegistryItem> {
  const model = catalogModel(filename)
  return {
    ...model,
    registryPath: registryPath ?? model.registryPath,
    expectedSize: GGUF.length,
    sha256Checksum: await stagedGgufChecksum()
  }
}

// Makes each path read-only until `restore()`. `effective` is false when that
// has no effect, for example when running as root.
function makeReadOnly(paths: string[]): { effective: boolean; restore: () => void } {
  const modes = paths.map((target) => fs.statSync(target).mode & 0o777)
  paths.forEach((target, i) => fs.chmodSync(target, modes[i]! & 0o555))
  const effective = paths.every((target) => {
    try {
      fs.accessSync(target, fs.constants.W_OK)
      return false
    } catch {
      return true
    }
  })
  return {
    effective,
    restore: () => paths.forEach((target, i) => fs.chmodSync(target, modes[i]!))
  }
}

// `root` and everything under it.
function treeOf(root: string): string[] {
  const entries = fs.readdirSync(root, { withFileTypes: true }) as unknown as Array<{
    name: string
    isDirectory(): boolean
  }>
  return [
    root,
    ...entries.flatMap((entry) => {
      const entryPath = path.join(root, entry.name)
      return entry.isDirectory() ? treeOf(entryPath) : [entryPath]
    })
  ]
}

/**
 * Loads `model` through the registry loader on macOS, with the model in the
 * catalog and the registry store held, so a download fails fast instead of
 * reaching the network.
 */
async function loadOnMac(
  t: { teardown: (fn: () => Promise<void>) => void },
  model: RegistryItem,
  prepare: () => (() => void) | void = () => {}
): Promise<unknown> {
  const home = makeTempHome('retired-coreml')
  const restoreHome = useRegistryHome(home)
  const context = getRuntimeContext()
  const platform = context.platform
  context.platform = 'darwin'
  const catalog = models as unknown as RegistryItem[]
  catalog.push(model)
  const holder = await holdStore()
  const restore = prepare()
  t.teardown(async () => {
    restore?.()
    await holder.release()
    catalog.splice(catalog.indexOf(model), 1)
    context.platform = platform
    await restoreHome()
    fs.rmSync(home, { recursive: true, force: true })
  })
  return downloadModelFromRegistry(model.registryPath, model.registrySource).catch(
    (error: unknown) => error
  )
}

function loaderRegistryPath(label: string): string {
  const unique = `${label}-${Math.random().toString(16).slice(2)}`
  return `qvac_models_compiled/ggml/parakeet/${unique}/${TDT_V3}.q8_0.gguf`
}

test('TDT v3 GGUFs load without the Core ML encoder on macOS and iOS', (t) => {
  for (const quant of ['f16', 'q4_0', 'q8_0']) {
    const model = catalogModel(`${TDT_V3}.${quant}.gguf`)
    for (const platform of ['darwin', 'ios']) {
      t.absent(
        getCoremlSidecarSpec(model.registryPath, model.registrySource, platform),
        `${quant} on ${platform} is not staged`
      )
      t.absent(findCatalogCoremlCompanionSet(model, platform))
    }
    const name = `${generateShortHash(model.registryPath)}_${TDT_V3}.${quant}.gguf`
    t.is(getModelCacheLayout(model, 'darwin', generateShortHash)?.path, name, 'single-file layout')
  }
})

test('Unified keeps its Core ML encoder', (t) => {
  const model = catalogModel(`${UNIFIED}.q8_0.gguf`)
  t.ok(getCoremlSidecarSpec(model.registryPath, model.registrySource, 'darwin'))
  t.absent(getRetiredCoremlSidecarSpec(model.registryPath, model.registrySource, 'darwin'))
})

test('the retired TDT v3 set keeps the key the earlier release staged it under', (t) => {
  const model = catalogModel(`${TDT_V3}.q8_0.gguf`)
  const spec = getRetiredCoremlSidecarSpec(model.registryPath, model.registrySource, 'ios')!
  t.ok(spec)
  t.is(spec.root, ENCODER_ROOT)
  t.alike(spec.bundles, [{ sourceName: `${TDT_V3}-encoder`, targetSuffix: '-encoder' }])
  // The set key the earlier release computed: shortHash(source:path:coreml:root).
  t.is(
    getCoremlSetKey(model, spec),
    generateShortHash(`s3:${model.registryPath}:coreml:${ENCODER_ROOT}`)
  )
  t.absent(getRetiredCoremlSidecarSpec(model.registryPath, model.registrySource, 'linux'))
  t.absent(getRetiredCoremlSetDir(model, 'android', '/cache'))
})

test('clearing a retired set keeps its GGUF as the single-file copy', async (t) => {
  const cacheDir = tempCache(t)
  const model = await stagedModel(`${TDT_V3}.q8_0.gguf`)
  const setDir = stageRetiredSet(cacheDir, model)
  const single = path.join(cacheDir, 'single.gguf')

  t.alike(await clearRetiredCoremlSet(model, 'darwin', single, cacheDir), { status: 'cleared' })
  t.is(fs.readFileSync(single, 'utf8'), GGUF, 'the GGUF moved')
  t.absent(fs.existsSync(setDir), 'the set and its bundle are gone')

  t.alike(
    await clearRetiredCoremlSet(model, 'darwin', single, cacheDir),
    { status: 'none' },
    'nothing left'
  )
})

test('clearing a retired set keeps a valid single-file copy', async (t) => {
  const cacheDir = tempCache(t)
  const model = await stagedModel(`${TDT_V3}.f16.gguf`)
  const setDir = stageRetiredSet(cacheDir, model)
  const single = path.join(cacheDir, 'single.gguf')
  fs.writeFileSync(single, GGUF)
  const inode = fs.statSync(single).ino

  t.alike(await clearRetiredCoremlSet(model, 'ios', single, cacheDir), { status: 'cleared' })
  t.is(fs.statSync(single).ino, inode, 'the single-file copy stays')
  t.absent(fs.existsSync(setDir))
})

test('a set GGUF that fails the checks does not replace the single-file copy', async (t) => {
  const cacheDir = tempCache(t)
  // The catalog size and checksum: the staged bytes match neither.
  const model = catalogModel(`${TDT_V3}.f16.gguf`)
  const setDir = stageRetiredSet(cacheDir, model)
  const single = path.join(cacheDir, 'single.gguf')
  fs.writeFileSync(single, 'already here')

  t.alike(await clearRetiredCoremlSet(model, 'ios', single, cacheDir), { status: 'cleared' })
  t.is(fs.readFileSync(single, 'utf8'), 'already here', 'the loader replaces it by downloading')
  t.absent(fs.existsSync(setDir))
})

test('a retired set without its GGUF is still removed', async (t) => {
  const cacheDir = tempCache(t)
  const model = await stagedModel(`${TDT_V3}.q4_0.gguf`)
  const setDir = stageRetiredSet(cacheDir, model)
  fs.rmSync(path.join(setDir, `${TDT_V3}.q4_0.gguf`))
  const single = path.join(cacheDir, 'single.gguf')

  t.alike(await clearRetiredCoremlSet(model, 'darwin', single, cacheDir), { status: 'cleared' })
  t.absent(fs.existsSync(single), 'the loader downloads the GGUF')
  t.absent(fs.existsSync(setDir))
})

test('a valid set GGUF that cannot be moved keeps its set', async (t) => {
  const cacheDir = tempCache(t)
  const model = await stagedModel(`${TDT_V3}.q8_0.gguf`)
  const setDir = stageRetiredSet(cacheDir, model)
  const single = path.join(cacheDir, 'single.gguf')
  const readOnly = makeReadOnly([setDir])
  // Before the temp cache is removed.
  t.teardown(() => readOnly.restore(), { order: -1 })
  if (!readOnly.effective) {
    t.comment('directories stay writable for this user, so the case cannot be set up')
    return
  }

  const result = await clearRetiredCoremlSet(model, 'darwin', single, cacheDir)
  t.is(result.status, 'kept')
  t.is(result.status === 'kept' && result.ggufPath, path.join(setDir, `${TDT_V3}.q8_0.gguf`))
  t.is(fs.readFileSync(path.join(setDir, `${TDT_V3}.q8_0.gguf`), 'utf8'), GGUF, 'the GGUF stays')
  t.ok(fs.existsSync(path.join(setDir, `${TDT_V3}-encoder.mlmodelc`)), 'the set stays')
  t.absent(fs.existsSync(single))
})

test('a linked GGUF has no Core ML bundle beside it', async (t) => {
  const cacheDir = tempCache(t)
  const linkRoot = tempCache(t)
  const model = await stagedModel(`${TDT_V3}.q8_0.gguf`)
  const setDir = stageRetiredSet(cacheDir, model)
  const gguf = path.join(setDir, `${TDT_V3}.q8_0.gguf`)
  const before = treeOf(cacheDir)

  const link = await linkAwayFromCoremlBundles(gguf, linkRoot)
  t.ok(isPathWithinBase(linkRoot, link), 'the link is under the given directory')
  t.is(path.basename(link), `${TDT_V3}.q8_0.gguf`, 'it keeps the file name')
  t.is(fs.readFileSync(link, 'utf8'), GGUF, 'it reads the GGUF')
  t.absent(fs.existsSync(path.join(path.dirname(link), `${TDT_V3}-encoder.mlmodelc`)))
  t.alike(treeOf(cacheDir), before, 'nothing is written beside the GGUF')
  t.is(await linkAwayFromCoremlBundles(gguf, linkRoot), link, 'a later load reuses the same link')
  t.is(fs.readdirSync(linkRoot).length, 1, 'repeated loads leave one directory')
})

test('concurrent loads of one GGUF all get the same working link', async (t) => {
  const linkRoot = tempCache(t)
  const cacheDir = tempCache(t)
  const model = await stagedModel(`${TDT_V3}.q8_0.gguf`)
  const setDir = stageRetiredSet(cacheDir, model)
  const gguf = path.join(setDir, `${TDT_V3}.q8_0.gguf`)

  const links = await Promise.all(
    Array.from({ length: 8 }, () => linkAwayFromCoremlBundles(gguf, linkRoot))
  )
  t.is(new Set(links).size, 1, 'every load gets the same path')
  t.is(fs.readFileSync(links[0]!, 'utf8'), GGUF, 'it reads the GGUF')
  t.alike(
    fs.readdirSync(path.dirname(links[0]!)),
    [path.basename(gguf)],
    'no staged links are left'
  )
})

test('a stale link to another file is replaced', async (t) => {
  const linkRoot = tempCache(t)
  const cacheDir = tempCache(t)
  const model = await stagedModel(`${TDT_V3}.q8_0.gguf`)
  const setDir = stageRetiredSet(cacheDir, model)
  const gguf = path.join(setDir, `${TDT_V3}.q8_0.gguf`)

  const link = await linkAwayFromCoremlBundles(gguf, linkRoot)
  fs.rmSync(link)
  fs.symlinkSync(path.join(cacheDir, 'elsewhere.gguf'), link)
  t.is(await linkAwayFromCoremlBundles(gguf, linkRoot), link, 'the same path is returned')
  t.is(fs.readlinkSync(link), gguf, 'the link points at the GGUF again')
  t.is(fs.readFileSync(link, 'utf8'), GGUF, 'it reads the GGUF')
  t.alike(fs.readdirSync(path.dirname(link)), [path.basename(gguf)], 'no staged links are left')
})

test('clearing touches nothing off Apple or for a model whose set is current', async (t) => {
  const cacheDir = tempCache(t)
  const tdt = catalogModel(`${TDT_V3}.q8_0.gguf`)
  const setDir = stageRetiredSet(cacheDir, tdt)
  const single = path.join(cacheDir, 'single.gguf')
  for (const platform of ['linux', 'android', 'win32', undefined]) {
    t.alike(
      await clearRetiredCoremlSet(tdt, platform, single, cacheDir),
      { status: 'none' },
      String(platform)
    )
  }
  t.ok(fs.existsSync(setDir))

  const unified = catalogModel(`${UNIFIED}.q8_0.gguf`)
  const spec = getCoremlSidecarSpec(unified.registryPath, unified.registrySource, 'darwin')!
  const unifiedSet = path.join(cacheDir, 'sets', getCoremlSetKey(unified, spec))
  fs.mkdirSync(unifiedSet, { recursive: true })
  t.alike(await clearRetiredCoremlSet(unified, 'darwin', single, cacheDir), { status: 'none' })
  t.ok(fs.existsSync(unifiedSet), "Unified's set is kept")
})

test("a retired set's metadata is read with the bundles that release staged", async (t) => {
  const cacheDir = tempCache(t)
  const model = catalogModel(`${TDT_V3}.q8_0.gguf`)
  const spec = getRetiredCoremlSidecarSpec(model.registryPath, model.registrySource, 'darwin')!
  const components = [
    'analytics/coremldata.bin',
    'coremldata.bin',
    'metadata.json',
    'model.mil',
    'weights/weight.bin'
  ]
  const file = (key: string, registryPath: string, targetName: string, size: number) => ({
    key,
    registryPath,
    registrySource: 's3',
    targetName,
    expectedSize: size,
    sha256Checksum: 'b'.repeat(64),
    blobCoreKey: 'core',
    blobBlockOffset: 0,
    blobBlockLength: 1,
    blobByteOffset: 0,
    primary: false
  })
  const set = {
    setKey: getCoremlSetKey(model, spec),
    primaryKey: 'modelPath',
    files: [
      {
        ...file('modelPath', model.registryPath, `${TDT_V3}.q8_0.gguf`, model.expectedSize),
        sha256Checksum: model.sha256Checksum,
        primary: true
      },
      ...components.map((component) =>
        file(
          `${TDT_V3}-encoder/${component}`,
          `${ENCODER_ROOT}${TDT_V3}-encoder.mlmodelc/${component}`,
          `${TDT_V3}-encoder.mlmodelc/${component}`,
          1
        )
      )
    ]
  }
  const setDir = path.join(cacheDir, 'sets', set.setKey)
  fs.mkdirSync(setDir, { recursive: true })
  fs.writeFileSync(path.join(setDir, '.coreml-companions.json'), JSON.stringify(set))

  const read = await readRetiredCoremlCompanionSet(model, 'darwin', cacheDir)
  t.is(read?.files.length, 6)
  t.absent(await readRetiredCoremlCompanionSet(model, 'linux', cacheDir))
})

test('a valid set GGUF replaces a truncated or corrupt single-file copy', async (t) => {
  for (const [label, content] of [
    ['truncated', 'gg'],
    ['corrupt', 'GGUF']
  ] as const) {
    const cacheDir = tempCache(t)
    const model = await stagedModel(`${TDT_V3}.q8_0.gguf`)
    const setDir = stageRetiredSet(cacheDir, model)
    const single = path.join(cacheDir, 'single.gguf')
    fs.writeFileSync(single, content)

    await clearRetiredCoremlSet(model, 'darwin', single, cacheDir)
    t.is(fs.readFileSync(single, 'utf8'), GGUF, `the set's GGUF replaced the ${label} copy`)
    t.absent(fs.existsSync(setDir), 'the set and its bundle are gone')
  }
})

test('loading replaces a corrupt single-file copy with the retired set GGUF, offline', async (t) => {
  const cacheDir = useTestCacheDir()
  const model = await stagedModel(`${TDT_V3}.q8_0.gguf`, loaderRegistryPath('corrupt'))
  const setDir = stageRetiredSet(cacheDir, model)
  const single = getSingleFileCachePath(model.registryPath)
  fs.writeFileSync(single, 'GGUF')
  t.teardown(() => {
    fs.rmSync(setDir, { recursive: true, force: true })
    fs.rmSync(single, { force: true })
  })

  const loaded = await loadOnMac(t, model)
  t.is(
    loaded,
    single,
    `the single-file copy loads ${loaded instanceof Error ? loaded.message : ''}`
  )
  t.is(fs.readFileSync(single, 'utf8'), GGUF, "it holds the set's GGUF")
  t.absent(fs.existsSync(setDir), 'the set and its bundle are gone')
})

test("a read-only cache loads a retired set's GGUF without its bundle and changes nothing", async (t) => {
  const cacheDir = useTestCacheDir()
  const model = await stagedModel(`${TDT_V3}.q8_0.gguf`, loaderRegistryPath('read-only'))
  const setDir = stageRetiredSet(cacheDir, model)
  const before = treeOf(cacheDir)
  let readOnly = { effective: false, restore: () => {} }
  let loadDir: string | undefined
  t.teardown(() => {
    readOnly.restore()
    fs.rmSync(setDir, { recursive: true, force: true })
    if (loadDir && !isPathWithinBase(cacheDir, loadDir)) {
      fs.rmSync(loadDir, { recursive: true, force: true })
    }
  })

  const loaded = await loadOnMac(t, model, () => {
    readOnly = makeReadOnly(treeOf(cacheDir))
  })
  if (!readOnly.effective) {
    t.comment('directories stay writable for this user, so the case cannot be set up')
    return
  }
  if (typeof loaded !== 'string') {
    t.fail(`the model loads: ${loaded instanceof Error ? loaded.message : String(loaded)}`)
    return
  }
  loadDir = path.dirname(loaded)
  t.is(fs.readFileSync(loaded, 'utf8'), GGUF, "the set's GGUF loads")
  t.absent(
    fs.existsSync(path.join(path.dirname(loaded), `${TDT_V3}-encoder.mlmodelc`)),
    'no Core ML bundle sits beside the loaded path'
  )
  t.alike(treeOf(cacheDir), before, 'nothing in the cache changed')
  t.ok(fs.existsSync(path.join(setDir, `${TDT_V3}-encoder.mlmodelc`)), 'the set is intact')
})
