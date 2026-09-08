import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { useModelServer } from '../helpers/server.js'
import { collectSSE } from '../helpers/http.js'

const ALIAS = 'test-nmt'

const TRANSLATE_CONFIG = {
  serve: {
    models: {
      [ALIAS]: {
        model: 'BERGAMOT_DE_EN',
        preload: true,
        config: { engine: 'Bergamot', from: 'de', to: 'en' }
      }
    }
  }
}

interface TranslationResult {
  object: string
  model: string
  translations: string[]
  stats?: Record<string, number>
}

describe('qvac translate: real NMT model', () => {
  const server = useModelServer(TRANSLATE_CONFIG)

  function translate(payload: unknown) {
    return server().inject({
      method: 'POST',
      url: '/qvac/v1/translate',
      payload: payload as object
    })
  }

  it('translates a single input into the configured target language', async () => {
    const res = await translate({ model: ALIAS, text: 'Guten Morgen' })
    assert.equal(res.statusCode, 200)

    const body = res.json() as TranslationResult
    assert.equal(body.object, 'translation')
    assert.equal(body.model, ALIAS)
    assert.equal(body.translations.length, 1)

    const [first] = body.translations
    assert.ok(first!.trim().length > 0, 'expected a non-empty translation')
    assert.notEqual(first, 'Guten Morgen')
    assert.match(first!, /morning/i)
  })

  it('reports engine stats for a translation', async () => {
    const res = await translate({ model: ALIAS, text: 'Das Wetter ist heute schön.' })
    assert.equal(res.statusCode, 200)

    const stats = (res.json() as TranslationResult).stats
    assert.ok(stats, 'expected the NMT engine to report stats')
    assert.ok(Number.isFinite(stats['totalTime']), 'expected a numeric totalTime')
  })

  it('translates a batch, keeping each result aligned with its input', async () => {
    const res = await translate({ model: ALIAS, text: ['Guten Morgen', 'Vielen Dank'] })
    assert.equal(res.statusCode, 200)

    const body = res.json() as TranslationResult
    assert.equal(body.translations.length, 2)
    assert.match(body.translations[0]!, /morning/i)
    assert.match(body.translations[1]!, /thank/i)
  })

  it('streams a batch as one item per input', async () => {
    const res = await translate({
      model: ALIAS,
      text: ['Guten Morgen', 'Vielen Dank'],
      stream: true
    })
    assert.equal(res.statusCode, 200)

    const events = collectSSE(res.body)
    const items = events
      .slice(0, -2)
      .map((e) => e.data as { object: string; index: number; text: string })
    assert.deepEqual(
      items.map((item) => item.index),
      [0, 1]
    )
    assert.ok(items.every((item) => item.object === 'translation.item'))
    assert.match(items[0]!.text, /morning/i)
    assert.match(items[1]!.text, /thank/i)
  })

  it('streams a translation over SSE and ends with stats', async () => {
    const res = await translate({ model: ALIAS, text: 'Guten Morgen', stream: true })
    assert.equal(res.statusCode, 200)
    assert.match(String(res.headers['content-type']), /text\/event-stream/)

    const events = collectSSE(res.body)
    assert.equal(events.at(-1)?.data, '[DONE]')

    const done = events.at(-2)?.data as { object: string; stats?: Record<string, number> }
    assert.equal(done.object, 'translation.done')

    const streamed = events
      .slice(0, -2)
      .map((e) => (e.data as { object: string; delta: string }).delta)
      .join('')
    assert.match(streamed, /morning/i)
  })

  it('rejects an unconfigured alias', async () => {
    const res = await translate({ model: 'not-configured', text: 'Guten Morgen' })
    assert.equal(res.statusCode, 404)
  })
})
