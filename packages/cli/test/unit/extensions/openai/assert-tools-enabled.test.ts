import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { assertToolsEnabled, toolsRequested } from '@/serve/lib/assert-tools-enabled'
import { HttpError } from '@/serve/lib/http-error'

const TOOLS = [{ name: 'get_weather' }]

describe('assertToolsEnabled', () => {
  it('rejects a tools request when the model was loaded without tools: true', () => {
    assert.throws(
      () => assertToolsEnabled({ ctx_size: 2048 }, TOOLS, 'my-llm'),
      (err: unknown) =>
        err instanceof HttpError &&
        err.status === 400 &&
        err.code === 'tools_not_enabled' &&
        err.message.includes('serve.models.my-llm.config.tools')
    )
  })

  it('allows a tools request when the model was loaded with tools: true', () => {
    assert.doesNotThrow(() => assertToolsEnabled({ tools: true }, TOOLS, 'my-llm'))
  })

  it('rejects a tools request when config.tools is not boolean true', () => {
    assert.throws(
      () => assertToolsEnabled({ tools: 'true' }, TOOLS, 'my-llm'),
      (err: unknown) => err instanceof HttpError && err.code === 'tools_not_enabled'
    )
  })

  it('does not reject when the request has no tools', () => {
    assert.doesNotThrow(() => assertToolsEnabled({}, undefined, 'my-llm'))
    assert.doesNotThrow(() => assertToolsEnabled({}, [], 'my-llm'))
  })
})

describe('toolsRequested', () => {
  it('is true only for a non-empty tools list', () => {
    assert.equal(toolsRequested(undefined), false)
    assert.equal(toolsRequested([]), false)
    assert.equal(toolsRequested(TOOLS), true)
  })
})
