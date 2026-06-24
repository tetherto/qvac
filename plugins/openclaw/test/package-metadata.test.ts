import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'

interface PackageJson {
  readonly openclaw?: {
    readonly extensions?: readonly string[]
  }
}

interface PluginManifest {
  readonly modelCatalog?: {
    readonly providers?: {
      readonly qvac?: {
        readonly api?: string
        readonly models?: readonly {
          readonly id: string
          readonly name: string
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

test('openclaw.plugin.json declares static QVAC model catalog rows', () => {
  const manifest = JSON.parse(readFileSync(new URL('../openclaw.plugin.json', import.meta.url), 'utf8')) as PluginManifest

  assert.equal(manifest.modelCatalog?.providers?.qvac?.api, 'openai-completions')
  assert.equal(manifest.modelCatalog?.discovery?.qvac, 'static')
  assert.deepEqual(manifest.modelCatalog?.providers?.qvac?.models?.map((model) => model.id), [
    'qwen3.5-0.8b',
    'qwen3.5-2b',
    'qwen3.5-4b',
    'qwen3.5-9b'
  ])
  assert.deepEqual(
    manifest.modelCatalog?.providers?.qvac?.models?.map((model) => model.compat),
    [
      { requiresStringContent: true },
      { requiresStringContent: true },
      { requiresStringContent: true },
      { requiresStringContent: true }
    ]
  )
})
