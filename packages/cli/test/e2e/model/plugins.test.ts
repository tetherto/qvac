import { after, describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

// An addon-free custom plugin, registered the way a `qvac bundle sdk` worker
// entry does. The entry sits inside the package so the worker resolves
// `@qvac/sdk` and `zod` from its node_modules.
const WORKER_ENTRY = `
import { z } from 'zod'
import { initializeWorker, ensureRPCSetup } from '@qvac/sdk/worker-lifecycle'
import { registerPlugin } from '@qvac/sdk/plugins'

const { hasRPCConfig } = initializeWorker()

registerPlugin({
  modelType: 'echo-plugin',
  displayName: 'Echo',
  addonPackage: '@qvac/echo-plugin',
  loadConfigSchema: z.object({}),
  skipPrimaryModelPathValidation: true,
  createModel() {
    return { model: { load: async function () {}, unload: async function () {} } }
  },
  handlers: {
    echo: {
      requestSchema: z.object({ text: z.string() }),
      responseSchema: z.object({ text: z.string() }),
      streaming: false,
      handler: async function ({ text }) {
        return { text }
      }
    },
    count: {
      requestSchema: z.object({ to: z.number().int().positive() }),
      responseSchema: z.object({ n: z.number() }),
      streaming: true,
      handler: async function* ({ to }) {
        for (let n = 1; n <= to; n++) yield { n }
      }
    }
  }
})

if (hasRPCConfig) ensureRPCSetup()
`

const PACKAGE_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..')
const workerDir = mkdtempSync(join(PACKAGE_ROOT, '.tmp-plugin-worker-'))
writeFileSync(join(workerDir, 'worker.entry.mjs'), WORKER_ENTRY)
writeFileSync(join(workerDir, 'echo.bin'), '')
after(() => rmSync(workerDir, { recursive: true, force: true }))

// Read once when the SDK client loads, so it has to be set before that import.
process.env['QVAC_WORKER_PATH'] = join(workerDir, 'worker.entry.mjs')
const { useModelServer } = await import('../helpers/server.js')

const URL = '/qvac/v1/plugins/echo-plugin/invoke'

const CONFIG = {
  serve: {
    models: { echo: { src: join(workerDir, 'echo.bin'), type: 'echo-plugin', preload: true } }
  }
}

function code(res: { json: () => unknown }): string {
  return (res.json() as { error: { code: string } }).error.code
}

describe('qvac plugins: a custom plugin in the worker', () => {
  const server = useModelServer(CONFIG, { enableAdmin: true })

  function invoke(payload: Record<string, unknown>) {
    return server().inject({ method: 'POST', url: URL, payload: { model: 'echo', ...payload } })
  }

  it('calls a reply handler', async () => {
    const res = await invoke({ handler: 'echo', params: { text: 'hi' } })
    assert.equal(res.statusCode, 200, res.payload)
    assert.deepEqual(res.json(), {
      object: 'plugin.invocation',
      model: 'echo',
      handler: 'echo',
      result: { text: 'hi' }
    })
  })

  it('streams a streaming handler', async () => {
    const res = await invoke({ handler: 'count', params: { to: 3 }, stream: true })
    assert.equal(res.statusCode, 200, res.payload)
    const events = res.payload
      .split('\n\n')
      .filter((frame) => frame.startsWith('data: '))
      .map((frame) => frame.slice('data: '.length))
    assert.equal(events.at(-1), '[DONE]')
    const objects = events.slice(0, -1).map((data) => JSON.parse(data) as Record<string, unknown>)
    assert.deepEqual(
      objects.map((e) => e['result']),
      [{ n: 1 }, { n: 2 }, { n: 3 }, undefined]
    )
    assert.equal(objects.at(-1)?.['object'], 'plugin.invocation.done')
  })

  it('answers 404 handler_not_found for a handler the plugin lacks', async () => {
    const res = await invoke({ handler: 'nope' })
    assert.equal(res.statusCode, 404)
    assert.equal(code(res), 'handler_not_found')
  })

  it('answers 400 invalid_plugin_params when the plugin rejects params', async () => {
    const res = await invoke({ handler: 'echo', params: { text: 1 } })
    assert.equal(res.statusCode, 400)
    assert.equal(code(res), 'invalid_plugin_params')
  })

  it('answers 400 handler_type_mismatch when stream does not match the handler', async () => {
    for (const payload of [
      { handler: 'count', params: { to: 1 } },
      { handler: 'echo', params: { text: 'hi' }, stream: true }
    ]) {
      const res = await invoke(payload)
      assert.equal(res.statusCode, 400, JSON.stringify(payload))
      assert.equal(code(res), 'handler_type_mismatch')
    }
  })
})
