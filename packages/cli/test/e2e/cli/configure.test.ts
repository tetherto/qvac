import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm, readFile, writeFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { runCli } from '../helpers/cli.js'
import { parseServeConfig } from '@/serve/core/config'

function tmp(): Promise<string> {
  return mkdtemp(join(tmpdir(), 'qvac-configure-'))
}

async function readConfig(dir: string): Promise<{ serve: { models: Record<string, unknown> } }> {
  const raw = await readFile(join(dir, 'qvac.config.json'), 'utf8')
  return JSON.parse(raw) as { serve: { models: Record<string, unknown> } }
}

describe('cli: configure', () => {
  it('--yes writes a valid default starter (chat + transcription)', async () => {
    const dir = await tmp()
    try {
      const res = await runCli(['configure', '--yes'], { cwd: dir })
      assert.equal(res.code, 0, res.output)
      const cfg = await readConfig(dir)
      assert.deepEqual(Object.keys(cfg.serve.models).sort(), [
        'qwen3-600m-inst-q4',
        'whisper-tiny-q8-0'
      ])
      // Structural validity: it must parse through the real serve config parser.
      parseServeConfig(cfg as Parameters<typeof parseServeConfig>[0], {})
      assert.match(res.output, /docs\.qvac\.tether\.io/)
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  it('--modality selects specific modalities (image gets prediction config)', async () => {
    const dir = await tmp()
    try {
      const res = await runCli(['configure', '--modality', 'chat', '--modality', 'image'], {
        cwd: dir
      })
      assert.equal(res.code, 0, res.output)
      const cfg = await readConfig(dir)
      const keys = Object.keys(cfg.serve.models).sort()
      assert.deepEqual(keys, ['qwen3-600m-inst-q4', 'sd-v2-1-1b-q8-0'])
      const image = cfg.serve.models['sd-v2-1-1b-q8-0'] as { config?: { prediction?: string } }
      assert.equal(image.config?.prediction, 'v')
      parseServeConfig(cfg as Parameters<typeof parseServeConfig>[0], {})
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  it('preserves existing entries and skips conflicts unless --force', async () => {
    const dir = await tmp()
    try {
      await runCli(['configure', '--modality', 'chat'], { cwd: dir })
      const second = await runCli(['configure', '--modality', 'chat'], { cwd: dir })
      assert.match(second.output, /already configured/i)
      const cfg = await readConfig(dir)
      assert.deepEqual(Object.keys(cfg.serve.models), ['qwen3-600m-inst-q4'])
      const forced = await runCli(['configure', '--modality', 'chat', '--force'], { cwd: dir })
      assert.equal(forced.code, 0, forced.output)
      // --force overwrites the existing alias in place; it must not mint a
      // deduped `qwen3-600m-inst-q4-2`.
      const afterForce = await readConfig(dir)
      assert.deepEqual(Object.keys(afterForce.serve.models), ['qwen3-600m-inst-q4'])
      assert.match(forced.output, /updated/i)
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  it('refuses to shadow a non-JSON config and points at the docs', async () => {
    const dir = await tmp()
    try {
      await writeFile(join(dir, 'qvac.config.ts'), 'export default {}\n')
      const res = await runCli(['configure', '--yes'], { cwd: dir })
      assert.equal(res.code, 0, res.output)
      assert.match(res.output, /qvac\.config\.ts/)
      assert.equal(existsSync(join(dir, 'qvac.config.json')), false)
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  it('rejects an unknown modality', async () => {
    const res = await runCli(['configure', '--modality', 'bogus'], { timeoutMs: 5000 })
    assert.equal(res.code, 1)
    assert.match(res.output, /Unknown modality/i)
  })
})
