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
        readonly apiKey?: unknown
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
  const packageJson = JSON.parse(
    readFileSync(new URL('../package.json', import.meta.url), 'utf8')
  ) as PackageJson

  assert.deepEqual(packageJson.openclaw?.extensions, ['./dist/index.js'])
})

test('README install instructions materialize QVAC credentials through onboarding', () => {
  const readme = readFileSync(new URL('../README.md', import.meta.url), 'utf8')
  const installSection = readme.slice(
    readme.indexOf('## Install'),
    readme.indexOf('## Manual Local Testing')
  )

  assert.match(installSection, /openclaw onboard[\s\S]*--auth-choice provider-plugin:qvac/)
  assert.match(installSection, /--non-interactive/)
  assert.match(installSection, /enabling[\s\S]*does\s+not[\s\S]*credentials?/i)
  assert.doesNotMatch(readme, /no additional auth setup is needed/i)
})

test('README explains QVAC key updates and recovery through onboarding', () => {
  const readme = readFileSync(new URL('../README.md', import.meta.url), 'utf8')
  const configureSection = readme.slice(
    readme.indexOf('## Configure'),
    readme.indexOf('## Troubleshooting')
  )
  const troubleshootingSection = readme.slice(
    readme.indexOf('## Troubleshooting'),
    readme.indexOf('## What It Registers')
  )

  assert.match(
    configureSection,
    /`apiKey`\s+changes[\s\S]*re-running[\s\S]*`openclaw onboard --auth-choice provider-plugin:qvac`/i
  )
  assert.match(
    troubleshootingSection,
    /missing[\s\S]*permission[\s\S]*openclaw onboard --auth-choice provider-plugin:qvac/i
  )
  assert.match(troubleshootingSection, /recreate[\s\S]*self-heal/i)
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
  const manifest = JSON.parse(
    readFileSync(new URL('../openclaw.plugin.json', import.meta.url), 'utf8')
  ) as PluginManifest

  assert.equal(manifest.modelCatalog?.providers?.qvac?.api, 'openai-completions')
  assert.equal(manifest.modelCatalog?.providers?.qvac?.apiKey, undefined)
  assert.equal(manifest.modelCatalog?.discovery?.qvac, 'static')
  assert.deepEqual(
    manifest.modelCatalog?.providers?.qvac?.models?.map((model) => model.id),
    [
      'qwen3.5-0.8b',
      'qwen3.5-2b',
      'qwen3.5-4b',
      'qwen3.5-9b',
      'qwen3.6-27b',
      'qwen3.6-35b-a3b',
      'gpt-oss-20b',
      'gemma4-31b'
    ]
  )
  assert.deepEqual(
    manifest.modelCatalog?.providers?.qvac?.models?.map((model) => model.input),
    [
      ['text', 'image'],
      ['text', 'image'],
      ['text', 'image'],
      ['text', 'image'],
      ['text', 'image'],
      ['text', 'image'],
      ['text'],
      ['text', 'image']
    ]
  )
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
  assert.deepEqual(manifest.configSchema?.properties?.['apiKey'], {
    type: 'string',
    minLength: 32,
    maxLength: 128,
    pattern: '^[A-Za-z0-9_][A-Za-z0-9_-]{31,127}$',
    description: 'Optional base64url bearer key to materialize into the private QVAC key file.'
  })
})
