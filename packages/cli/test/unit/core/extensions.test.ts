import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { tmpdir } from 'node:os'
import { buildServer } from '@/serve/index'
import { extensionErrorCodes, type ServeExtension } from '@/serve/core/extensions'
import { DEFAULT_EXTENSION, EXTENSIONS, resolveExtensions } from '@/serve/extensions'

function routePaths(printed: string): string[] {
  return printed
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
}

describe('resolveExtensions', () => {
  it('defaults to every registered extension', () => {
    assert.deepEqual(
      resolveExtensions().map((e) => e.name),
      EXTENSIONS.map((e) => e.name)
    )
  })

  it('resolves a named subset in the order given', () => {
    assert.deepEqual(
      resolveExtensions(['openai', DEFAULT_EXTENSION]).map((e) => e.name),
      ['openai', DEFAULT_EXTENSION]
    )
  })

  it('resolves an empty list to no extensions', () => {
    assert.deepEqual(resolveExtensions([]), [])
  })

  it('rejects an unknown name and lists what is available', () => {
    assert.throws(() => resolveExtensions(['nope']), /Unknown serve extension "nope".*openai/s)
  })
})

describe('extensionErrorCodes', () => {
  function stub(name: string, errorCodes: Record<string, string>): ServeExtension {
    // lunte-disable-next-line require-await
    return { name, description: name, errorCodes, register: async () => {} }
  }

  it('merges the codes of every mounted extension', () => {
    assert.deepEqual(
      extensionErrorCodes([
        stub('a', { text: 'missing_text' }),
        stub('b', { input: 'missing_input' })
      ]),
      { text: 'missing_text', input: 'missing_input' }
    )
  })

  it('allows two extensions to agree on the same field and code', () => {
    assert.deepEqual(
      extensionErrorCodes([
        stub('a', { text: 'missing_text' }),
        stub('b', { text: 'missing_text' })
      ]),
      { text: 'missing_text' }
    )
  })

  it('refuses a field two extensions map to different codes', () => {
    assert.throws(
      () =>
        extensionErrorCodes([stub('a', { text: 'missing_text' }), stub('b', { text: 'no_text' })]),
      /"a" and "b" both map the "text" request field/
    )
  })
})

describe('mounted surfaces', () => {
  async function build(extensions: string[]): Promise<string> {
    const app = await buildServer({
      projectRoot: tmpdir(),
      port: 0,
      host: '127.0.0.1',
      quiet: true,
      extensions
    })
    try {
      await app.ready()
      return app.printRoutes({ commonPrefix: false })
    } finally {
      await app.close()
    }
  }

  it('serves introspection but no API paths with no extension mounted', async () => {
    const paths = routePaths(await build([]))
    assert.ok(paths.some((p) => p.includes('openapi.json')))
    assert.ok(!paths.some((p) => p.includes('v1')))
  })

  it('mounts the QVAC paths for the default extension, and no OpenAI ones', async () => {
    const printed = await build([DEFAULT_EXTENSION])
    assert.match(printed, /\/qvac\/v1\/translate/)
    assert.ok(!printed.includes('chat'))
  })

  it('mounts the OpenAI paths when the openai extension is selected', async () => {
    const printed = await build(['openai'])
    assert.match(printed, /chat/)
    assert.match(printed, /embeddings/)
    assert.ok(!printed.includes('/qvac/'))
  })
})
