import test from 'brittle'
import { z } from 'zod'
import fs from 'bare-fs'
import os from 'bare-os'
import path from 'bare-path'

import { registerPlugin, clearPlugins } from '@/plugins/registry'
import { definePlugin, type ResolveContext } from '@/schemas/plugin'
import { ModelType } from '@/schemas/index'
import { resolveLoadFromStubs } from '@/resources/model-fit/fit-stub/resolve-load-from-stubs'

function scratchFile(name: string): string {
  const dir = path.join(os.tmpdir(), `fit-load-${Math.random().toString(36).slice(2)}`)
  fs.mkdirSync(dir, { recursive: true })
  const file = path.join(dir, name)
  fs.writeFileSync(file, 'weights')
  return file
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

test('resolve load: a model type with no plugin is not answered for', async (t) => {
  clearPlugins()

  const resolved = await resolveLoadFromStubs({
    modelSrc: scratchFile('model.gguf'),
    modelType: ModelType.llamacppCompletion,
    modelConfig: {}
  })

  t.is(resolved.status, 'unsupported-load')
})

// A source naming neither a local file nor registry coordinates has no stub to
// fetch, so the load cannot be described at all.
test('resolve load: a source with no registry coordinates resolves no stub', async (t) => {
  clearPlugins()
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
