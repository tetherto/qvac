import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'

import pluginEntry, { createQvacServeModels, resolveOptions } from '../src/index.ts'

interface PackageJson {
  readonly openclaw?: {
    readonly extensions?: readonly string[]
  }
}

interface PluginManifest {
  readonly configSchema?: {
    readonly properties?: Record<string, unknown>
  }
  readonly modelCatalog?: {
    readonly providers?: {
      readonly qvac?: {
        readonly api?: string
        readonly models?: readonly {
          readonly id: string
          readonly name: string
          readonly input?: readonly string[]
          readonly compat?: {
            readonly requiresStringContent?: boolean
          }
        }[]
      }
    }
    readonly discovery?: {
      readonly qvac?: string
    }
  }
}

test('package.json declares the OpenClaw runtime extension entrypoint', () => {
  const packageJson = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')) as PackageJson

  assert.deepEqual(packageJson.openclaw?.extensions, ['./dist/index.js'])
})

test('package entrypoint exports the plugin and serve config helpers', () => {
  assert.equal(typeof pluginEntry, 'object')
  assert.deepEqual(createQvacServeModels(resolveOptions())['qwen3.5-9b'], {
    model: 'QWEN3_5_9B_MULTIMODAL_Q4_K_M',
    preload: true,
    default: true,
    config: {
      ctx_size: 32768,
      reasoning_budget: -1,
      tools: true
    }
  })
})

test('openclaw.plugin.json declares static QVAC model catalog rows', () => {
  const manifest = JSON.parse(readFileSync(new URL('../openclaw.plugin.json', import.meta.url), 'utf8')) as PluginManifest

  assert.equal(manifest.modelCatalog?.providers?.qvac?.api, 'openai-completions')
  assert.equal(manifest.modelCatalog?.discovery?.qvac, 'static')
  assert.deepEqual(manifest.modelCatalog?.providers?.qvac?.models?.map((model) => model.id), [
    'qwen3.5-0.8b',
    'qwen3.5-2b',
    'qwen3.5-4b',
    'qwen3.5-9b',
    'qwen3.6-27b',
    'qwen3.6-35b-a3b',
    'gpt-oss-20b',
    'gemma4-31b'
  ])
  assert.deepEqual(manifest.modelCatalog?.providers?.qvac?.models?.map((model) => model.input), [
    ['text', 'image'],
    ['text', 'image'],
    ['text', 'image'],
    ['text', 'image'],
    ['text', 'image'],
    ['text', 'image'],
    ['text'],
    ['text', 'image']
  ])
  assert.deepEqual(
    manifest.modelCatalog?.providers?.qvac?.models?.map((model) => model.compat),
    [
      { requiresStringContent: true },
      { requiresStringContent: true },
      { requiresStringContent: true },
      { requiresStringContent: true },
      { requiresStringContent: true },
      { requiresStringContent: true },
      { requiresStringContent: true },
      { requiresStringContent: true }
    ]
  )
  assert.equal(Object.hasOwn(manifest.configSchema?.properties ?? {}, 'configPath'), false)
})
