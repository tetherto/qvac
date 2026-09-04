import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  DEFAULT_STARTER,
  TTS_VOICE_PLACEHOLDER,
  aliasFor,
  buildAdditions,
  buildEntry,
  buildGenericEntry
} from '@/configure/presets'
import { CONFIG_DOCS_URL, docsUrlForAddon } from '@/configure/docs-links'
import {
  foreignConfigPath,
  loadJsonConfig,
  mergeServeModels,
  serializeConfig,
  writeConfigAtomically
} from '@/configure/write-config'

describe('configure: presets / buildEntry', () => {
  it('builds a bare {model, preload:false} for chat with the recommended default', () => {
    const b = buildEntry('chat')
    assert.equal(b.addon, 'llm')
    assert.equal(b.aliasBase, 'QWEN3_600M_INST_Q4')
    assert.deepEqual(b.entry, { model: 'QWEN3_600M_INST_Q4', preload: false })
  })

  it('honors an explicit model choice', () => {
    assert.equal(buildEntry('chat', 'LLAMA3_2_1B_INST_Q4').entry.model, 'LLAMA3_2_1B_INST_Q4')
  })

  it('adds prediction config for image', () => {
    const b = buildEntry('image')
    assert.equal(b.entry.model, 'SD_V2_1_1B_Q8_0')
    assert.deepEqual(b.entry.config, { prediction: 'v' })
  })

  it('emits a TTS template with a placeholder voice', () => {
    const b = buildEntry('speech')
    assert.equal(b.addon, 'tts')
    assert.equal(b.entry.type, 'tts')
    assert.ok(b.entry.src)
    const cfg = b.entry.config as Record<string, unknown>
    assert.equal(cfg['referenceAudioSrc'], TTS_VOICE_PLACEHOLDER)
    assert.ok(cfg['s3genModelSrc'])
  })

  it('buildGenericEntry is a bare model entry', () => {
    assert.deepEqual(buildGenericEntry('FOO', 'llm').entry, { model: 'FOO', preload: false })
  })
})

describe('configure: aliasFor', () => {
  it('kebab-cases a constant name', () => {
    assert.equal(aliasFor('QWEN3_600M_INST_Q4', new Set()), 'qwen3-600m-inst-q4')
  })
  it('dedupes on collision', () => {
    const taken = new Set(['qwen3-600m-inst-q4'])
    assert.equal(aliasFor('QWEN3_600M_INST_Q4', taken), 'qwen3-600m-inst-q4-2')
  })
})

describe('configure: buildAdditions (non-interactive)', () => {
  it('builds the default starter (chat + transcription)', () => {
    const added = buildAdditions(
      DEFAULT_STARTER.map((modality) => ({ modality })),
      new Set()
    )
    assert.deepEqual(
      added.map((a) => a.alias),
      ['qwen3-600m-inst-q4', 'whisper-tiny-q8-0']
    )
    assert.equal(added[0]!.entry.preload, false)
  })
})

describe('configure: docs-links', () => {
  it('deep-links known addons to real docs pages', () => {
    assert.equal(
      docsUrlForAddon('llm'),
      'https://docs.qvac.tether.io/addons/llm-llamacpp/#4-create-the-config-obj'
    )
    assert.equal(docsUrlForAddon('tts'), 'https://docs.qvac.tether.io/addons/tts-ggml/')
    assert.equal(
      docsUrlForAddon('diffusion'),
      'https://docs.qvac.tether.io/addons/diffusion-cpp/#3-configure-the-native-backend-argsconfig'
    )
  })
  it('falls back to the configuration page for pageless / unknown addons', () => {
    assert.equal(docsUrlForAddon('ocr'), CONFIG_DOCS_URL)
    assert.equal(docsUrlForAddon(null), CONFIG_DOCS_URL)
  })
})

describe('configure: mergeServeModels', () => {
  it('adds new aliases and preserves existing config', () => {
    const existing = { serve: { models: { keep: { model: 'X' } }, publicBaseUrl: 'https://x' } }
    const { config, added, conflicts } = mergeServeModels(
      existing,
      { chat: { model: 'Y', preload: false } },
      false
    )
    assert.deepEqual(added, ['chat'])
    assert.deepEqual(conflicts, [])
    assert.deepEqual(config.serve!.models, {
      keep: { model: 'X' },
      chat: { model: 'Y', preload: false }
    })
    assert.equal(config.serve!['publicBaseUrl'], 'https://x')
  })
  it('skips a conflicting alias without force, overwrites with force', () => {
    const existing = { serve: { models: { chat: { model: 'OLD' } } } }
    const skip = mergeServeModels(existing, { chat: { model: 'NEW' } }, false)
    assert.deepEqual(skip.conflicts, ['chat'])
    assert.deepEqual(skip.added, [])
    assert.equal(skip.config.serve!.models!['chat']!.model, 'OLD')
    const over = mergeServeModels(existing, { chat: { model: 'NEW' } }, true)
    assert.deepEqual(over.added, ['chat'])
    assert.equal(over.config.serve!.models!['chat']!.model, 'NEW')
  })
})

describe('configure: write-config fs', () => {
  it('serializes with 2-space indent + trailing newline', () => {
    const s = serializeConfig({ serve: { models: {} } })
    assert.ok(s.endsWith('}\n'))
    assert.ok(s.includes('\n  "serve"'))
  })

  it('writes atomically and round-trips through loadJsonConfig; detects foreign config', () => {
    const dir = mkdtempSync(join(tmpdir(), 'qvac-cfg-'))
    try {
      const path = join(dir, 'qvac.config.json')
      writeConfigAtomically(path, { serve: { models: { chat: { model: 'X', preload: false } } } })
      const back = loadJsonConfig(path)
      assert.equal(back.serve!.models!['chat']!.model, 'X')
      assert.equal(foreignConfigPath(dir), null)
      writeFileSync(join(dir, 'qvac.config.ts'), 'export default {}\n')
      assert.equal(foreignConfigPath(dir), join(dir, 'qvac.config.ts'))
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})
