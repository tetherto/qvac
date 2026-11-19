import test from 'brittle'
import { z } from 'zod'
import fs from 'bare-fs'
import os from 'bare-os'
import path from 'bare-path'

import { PluginNotFoundError } from '@/errors/index'
import { registerPlugin, clearPlugins } from '@/plugins/registry'
import { definePlugin, type ResolveContext } from '@/schemas/plugin'
import { ModelType } from '@/schemas/index'
import { resolveLoadFromStubs } from '@/model-fit/description/resolve-load'
import { audioGenPlugin } from '@/plugins/builtin/audiogen-ggml/plugin'
import { models, type RegistryItem } from '@/models/registry/models'
import { getRuntimeContext } from '@/runtime/state'
import {
  getModelCacheLayout,
  getSingleFileCacheName,
  type ModelCacheLayout
} from '@/utils/cache/layout'
import { generateShortHash } from '@/utils/formatting'
import { useTestCacheDir } from './fixtures/test-cache'

function scratchFile(name: string): string {
  const dir = path.join(os.tmpdir(), `fit-load-${Math.random().toString(36).slice(2)}`)
  fs.mkdirSync(dir, { recursive: true })
  const file = path.join(dir, name)
  fs.writeFileSync(file, 'weights')
  return file
}

function layoutOf(entry: RegistryItem): ModelCacheLayout {
  const layout = getModelCacheLayout(entry, getRuntimeContext().platform, generateShortHash)
  if (layout === undefined) throw new Error(`${entry.name} has no cache layout`)
  return layout
}

function smallestEntry(matches: (entry: RegistryItem) => boolean): RegistryItem {
  const entry = (models as readonly RegistryItem[])
    .filter(matches)
    .sort((a, b) => a.expectedSize - b.expectedSize)[0]
  if (entry === undefined) throw new Error('no catalog entry matches')
  return entry
}

/**
 * Lays out a catalog model in the test models cache the way the loader does,
 * as sparse files of the registry sizes, and removes them on teardown.
 */
function cacheCatalogModel(
  t: { teardown(fn: () => void): void },
  entry: RegistryItem,
  sizeOf: (size: number) => number = (size) => size
): string {
  const cacheDir = useTestCacheDir()
  const layout = layoutOf(entry)
  for (const file of layout.files) sparseFile(path.join(cacheDir, file.path), sizeOf(file.size))
  t.teardown(() => fs.rmSync(path.join(cacheDir, layout.path), { recursive: true, force: true }))
  return cacheDir
}

/**
 * Lays out a companion set in the legacy flat cache, one file per registry
 * path, and removes the files on teardown. Returns the primary file's path.
 */
function cacheLegacyFlatSet(t: { teardown(fn: () => void): void }, entry: RegistryItem): string {
  const cacheDir = useTestCacheDir()
  const { files, primaryKey } = entry.companionSet!
  const paths = files.map((file) =>
    path.join(cacheDir, getSingleFileCacheName(file.registryPath, generateShortHash))
  )
  files.forEach((file, index) => sparseFile(paths[index]!, file.expectedSize))
  t.teardown(() => paths.forEach((file) => fs.rmSync(file, { force: true })))
  return paths[files.findIndex((file) => file.key === primaryKey)]!
}

function sparseFile(target: string, size: number): void {
  fs.mkdirSync(path.dirname(target), { recursive: true })
  const fd = fs.openSync(target, 'w')
  fs.ftruncateSync(fd, size)
  fs.closeSync(fd)
}

function catalogSrc(entry: RegistryItem) {
  return {
    src: `registry://${entry.registrySource}/${entry.registryPath}`,
    sha256Checksum: entry.sha256Checksum,
    registryPath: entry.registryPath,
    registrySource: entry.registrySource
  }
}

const isTranslationSet = (entry: RegistryItem) =>
  entry.addon === 'nmt' && entry.companionSet !== undefined

const isSingleFile = (entry: RegistryItem) => {
  const layout = getModelCacheLayout(entry, getRuntimeContext().platform, generateShortHash)
  return layout?.files.length === 1 && layout.files[0]?.path === layout.path
}

/**
 * Stands in for a real engine plugin: strips its companion source the way every
 * builtin does, and returns the artifact under the key its addon reads.
 */
function companionPlugin(modelType: string) {
  return definePlugin({
    modelType,
    displayName: 'test',
    addonPackage: '@qvac/test',
    loadConfigSchema: z.record(z.string(), z.unknown()),
    createModel: (() => {
      throw new Error('not loaded in this test')
    }) as never,
    handlers: {},
    async resolveConfig(config: Record<string, unknown>, ctx: ResolveContext) {
      const { companionSrc, ...rest } = config
      if (companionSrc === undefined) return { config: rest }
      return {
        config: rest,
        artifacts: { companionPath: await ctx.resolveModelPath(companionSrc as never) }
      }
    }
  } as never)
}

test('resolve load: reads a source already on disk rather than fetching a stub', async (t) => {
  clearPlugins()
  t.teardown(clearPlugins)
  registerPlugin(companionPlugin(ModelType.llamacppCompletion))
  const model = scratchFile('model.gguf')

  const resolved = await resolveLoadFromStubs({
    modelSrc: model,
    modelType: ModelType.llamacppCompletion,
    modelConfig: { ctx_size: 4096 }
  })

  t.is(resolved.status, 'resolved')
  if (resolved.status !== 'resolved') return
  t.is(resolved.modelPath, model, 'the file itself describes the load better than a stub')
  await resolved.release()
})

test('resolve load: takes the config and artifact keys from the plugin', async (t) => {
  clearPlugins()
  t.teardown(clearPlugins)
  registerPlugin(companionPlugin(ModelType.llamacppCompletion))
  const model = scratchFile('model.gguf')
  const companion = scratchFile('companion.gguf')

  const resolved = await resolveLoadFromStubs({
    modelSrc: model,
    modelType: ModelType.llamacppCompletion,
    modelConfig: { ctx_size: 4096, companionSrc: companion }
  })

  t.is(resolved.status, 'resolved')
  if (resolved.status !== 'resolved') return
  t.alike(resolved.artifacts, { companionPath: companion }, 'keyed as the engine reads it')
  t.alike(resolved.modelConfig, { ctx_size: 4096 }, 'the source field is stripped')
  await resolved.release()
})

test('resolve load: a load whose sources are all config fields needs no primary', async (t) => {
  clearPlugins()
  t.teardown(clearPlugins)
  registerPlugin(companionPlugin(ModelType.audiogenGgml))
  const companion = scratchFile('stage.gguf')

  const resolved = await resolveLoadFromStubs({
    modelType: ModelType.audiogenGgml,
    modelConfig: { companionSrc: companion }
  })

  t.is(resolved.status, 'resolved')
  if (resolved.status !== 'resolved') return
  t.is(resolved.modelPath, '', 'nothing to resolve a primary path from')
  t.alike(resolved.artifacts, { companionPath: companion })
  await resolved.release()
})

test('resolve load: a model type with no plugin throws as the load does', async (t) => {
  clearPlugins()
  t.teardown(clearPlugins)

  await t.exception(
    resolveLoadFromStubs({
      modelSrc: scratchFile('model.gguf'),
      modelType: ModelType.llamacppCompletion,
      modelConfig: {}
    }),
    PluginNotFoundError as never
  )
})

// A source naming neither a local file nor registry coordinates has no stub to
// fetch, so the load cannot be described at all.
test('resolve load: a source with no registry coordinates resolves no stub', async (t) => {
  clearPlugins()
  t.teardown(clearPlugins)
  registerPlugin(companionPlugin(ModelType.llamacppCompletion))

  const resolved = await resolveLoadFromStubs({
    modelSrc: 'https://example.invalid/model.gguf',
    modelType: ModelType.llamacppCompletion,
    modelConfig: {}
  })

  t.is(resolved.status, 'no-stub')
  if (resolved.status !== 'no-stub') return
  t.is(resolved.reason, 'unresolvable-ref')
})

test('resolve load: a minimax pair on disk resolves to the artifacts its plugin loads', async (t) => {
  clearPlugins()
  t.teardown(clearPlugins)
  registerPlugin(audioGenPlugin)
  const lm = scratchFile('mm3-lm-q8.gguf')
  const synth = scratchFile('mm3-synth-q8.gguf')

  const resolved = await resolveLoadFromStubs({
    modelType: ModelType.audiogenGgml,
    modelConfig: { engine: 'minimax', lmModelSrc: lm, synthModelSrc: synth, device: 'gpu' }
  })

  t.is(resolved.status, 'resolved')
  if (resolved.status !== 'resolved') return
  t.alike(resolved.artifacts, { lmModelPath: lm, synthModelPath: synth })
  await resolved.release()
})

test('resolve load: a minimax load naming both useGPU and device throws as the load does', async (t) => {
  clearPlugins()
  t.teardown(clearPlugins)
  registerPlugin(audioGenPlugin)

  await t.exception(
    resolveLoadFromStubs({
      modelType: ModelType.audiogenGgml,
      modelConfig: {
        engine: 'minimax',
        lmModelSrc: scratchFile('mm3-lm-q8.gguf'),
        synthModelSrc: scratchFile('mm3-synth-q8.gguf'),
        useGPU: true,
        device: 'gpu'
      }
    }),
    Error as never
  )
})

test('resolve load: a translation source not on disk fetches no stub', async (t) => {
  clearPlugins()
  t.teardown(clearPlugins)
  registerPlugin(companionPlugin(ModelType.nmtcppTranslation))

  const resolved = await resolveLoadFromStubs({
    modelSrc: {
      src: 'registry://s3/models/model.enfr.intgemm.alphas.bin',
      sha256Checksum: 'a'.repeat(64),
      registryPath: 'models/model.enfr.intgemm.alphas.bin',
      registrySource: 's3'
    },
    modelType: ModelType.nmtcppTranslation,
    modelConfig: {}
  })

  t.is(resolved.status, 'no-stub')
  if (resolved.status !== 'no-stub') return
  t.is(resolved.reason, 'files-only-engine')
})

test('resolve load: a translation model in the legacy flat cache is read from there', async (t) => {
  clearPlugins()
  t.teardown(clearPlugins)
  registerPlugin(companionPlugin(ModelType.nmtcppTranslation))
  const entry = smallestEntry(isTranslationSet)
  const primary = cacheLegacyFlatSet(t, entry)

  const resolved = await resolveLoadFromStubs({
    modelSrc: catalogSrc(entry),
    modelType: ModelType.nmtcppTranslation,
    modelConfig: {}
  })

  t.is(resolved.status, 'resolved')
  if (resolved.status !== 'resolved') return
  t.is(resolved.modelPath, primary)
  await resolved.release()
})

test('resolve load: a downloaded translation model is read from the models cache', async (t) => {
  clearPlugins()
  t.teardown(clearPlugins)
  registerPlugin(companionPlugin(ModelType.nmtcppTranslation))
  const entry = smallestEntry(isTranslationSet)
  const cacheDir = cacheCatalogModel(t, entry)
  const primary = entry.companionSet!.files.find(
    (file) => file.key === entry.companionSet!.primaryKey
  )!

  const resolved = await resolveLoadFromStubs({
    modelSrc: catalogSrc(entry),
    modelType: ModelType.nmtcppTranslation,
    modelConfig: {}
  })

  t.is(resolved.status, 'resolved')
  if (resolved.status !== 'resolved') return
  t.is(resolved.modelPath, path.join(cacheDir, layoutOf(entry).path, primary.targetName))
  await resolved.release()
})

test('resolve load: a downloaded single-file model is read from the models cache', async (t) => {
  clearPlugins()
  t.teardown(clearPlugins)
  registerPlugin(companionPlugin(ModelType.llamacppCompletion))
  const entry = smallestEntry(isSingleFile)
  const cacheDir = cacheCatalogModel(t, entry)

  const resolved = await resolveLoadFromStubs({
    modelSrc: catalogSrc(entry),
    modelType: ModelType.llamacppCompletion,
    modelConfig: {}
  })

  t.is(resolved.status, 'resolved')
  if (resolved.status !== 'resolved') return
  t.is(resolved.modelPath, path.join(cacheDir, layoutOf(entry).path))
  await resolved.release()
})

test('resolve load: a partly downloaded model in the cache is not read', async (t) => {
  clearPlugins()
  t.teardown(clearPlugins)
  registerPlugin(companionPlugin(ModelType.nmtcppTranslation))
  const entry = smallestEntry(isTranslationSet)
  cacheCatalogModel(t, entry, (size) => size - 1)

  const resolved = await resolveLoadFromStubs({
    modelSrc: catalogSrc(entry),
    modelType: ModelType.nmtcppTranslation,
    modelConfig: {}
  })

  t.is(resolved.status, 'no-stub')
  if (resolved.status !== 'no-stub') return
  t.is(resolved.reason, 'files-only-engine')
})

test('resolve load: a translation source on disk is read directly', async (t) => {
  clearPlugins()
  t.teardown(clearPlugins)
  registerPlugin(companionPlugin(ModelType.nmtcppTranslation))
  const model = scratchFile('model.enfr.intgemm.alphas.bin')

  const resolved = await resolveLoadFromStubs({
    modelSrc: model,
    modelType: ModelType.nmtcppTranslation,
    modelConfig: {}
  })

  t.is(resolved.status, 'resolved')
  if (resolved.status !== 'resolved') return
  t.is(resolved.modelPath, model)
  await resolved.release()
})
