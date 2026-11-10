// Boots a real OpenCode 2.x with the built plugin in a throwaway project and
// checks that the `qvac` provider and its model resolve. Skipped when no 2.x
// binary is found (OPENCODE_BIN, else `opencode` on PATH).
import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { existsSync } from 'node:fs'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { test } from 'node:test'
import { promisify } from 'node:util'

const run = promisify(execFile)

const pluginDir = resolve(import.meta.dirname, '..')
const model = process.env['QVAC_SMOKE_MODEL'] ?? 'qwen3.5-0.8b'
const bin = process.env['OPENCODE_BIN'] ?? 'opencode'

async function opencodeVersion(): Promise<string | undefined> {
  try {
    const { stdout } = await run(bin, ['--version'], { timeout: 30_000 })
    return stdout.trim().replace(/^opencode\s+v?/, '')
  } catch {
    return undefined
  }
}

const version = await opencodeVersion()
const skip =
  version === undefined
    ? `no opencode binary at "${bin}"`
    : version.startsWith('2.')
      ? false
      : `opencode ${version} is not 2.x`

interface Envelope<T> {
  readonly data: T
}

interface ModelInfo {
  readonly id: string
  readonly providerID: string
  readonly settings?: Record<string, unknown>
}

test(
  'OpenCode 2.x loads the plugin and resolves the qvac provider and model',
  { skip },
  async () => {
    assert.ok(
      existsSync(join(pluginDir, 'dist', 'index.js')),
      'build the plugin first (npm run test:smoke does)'
    )

    const project = await mkdtemp(join(tmpdir(), 'qvac-opencode-smoke-'))
    try {
      await writeFile(
        join(project, 'opencode.json'),
        JSON.stringify({ plugins: [{ package: pluginDir, options: { model } }] })
      )
      // Isolate OpenCode's own config, state and caches from the developer's.
      const env = {
        ...process.env,
        XDG_CONFIG_HOME: join(project, '.config'),
        XDG_DATA_HOME: join(project, '.data'),
        XDG_STATE_HOME: join(project, '.state'),
        XDG_CACHE_HOME: join(project, '.cache')
      }

      async function api<T>(operation: string): Promise<T> {
        const { stdout } = await run(bin, ['api', '--standalone', operation], {
          cwd: project,
          env,
          timeout: 120_000,
          maxBuffer: 64 * 1024 * 1024
        })
        return (JSON.parse(stdout) as Envelope<T>).data
      }

      const models = await api<ModelInfo[]>('model.list')
      const qvac = models.filter((m) => m.providerID === 'qvac')
      assert.deepEqual(
        qvac.map((m) => m.id),
        [model]
      )
      assert.match(String(qvac[0]?.settings?.['baseURL']), /^http:\/\/127\.0\.0\.1:\d+\/v1$/)

      const defaultModel = await api<ModelInfo>('model.default')
      assert.equal(defaultModel.providerID, 'qvac')
      assert.equal(defaultModel.id, model)
    } finally {
      await rm(project, { recursive: true, force: true })
    }
  }
)
