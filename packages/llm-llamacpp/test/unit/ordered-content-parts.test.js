'use strict'

const test = require('brittle')
const LlmLlamacpp = require('../../index.js')

function createModel() {
  const model = new LlmLlamacpp({
    files: { model: ['/models/model.gguf'] },
    config: { device: 'cpu', ctx_size: '256' },
    logger: { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} }
  })
  const sent = []
  model.addon = {
    activeJobs: () => 0,
    runJob: (items) => {
      sent.push(items)
      return { accepted: true, id: sent.length, ids: items.map((_, i) => `job-${i}`) }
    },
    cancel: () => Promise.resolve(),
    cancelJob: () => Promise.resolve()
  }
  return { model, sent }
}

test('ordered parts: byte media is hoisted in marker order and leaves path-less parts', async (t) => {
  const { model, sent } = createModel()
  const first = new Uint8Array([1, 1, 1])
  const second = new Uint8Array([2, 2])

  await model.run([
    {
      role: 'user',
      content: [
        { type: 'text', text: 'A:' },
        { type: 'media', content: first },
        { type: 'text', text: 'B:' },
        { type: 'media', content: 'images/b.jpg' },
        { type: 'text', text: 'C:' },
        { type: 'media', content: second }
      ]
    }
  ])

  const items = sent[0]
  const media = items.filter((item) => item.type === 'media')
  t.is(media.length, 2, 'only byte parts are hoisted')
  t.alike(Array.from(media[0].content), [1, 1, 1], 'first byte part is first in the media queue')
  t.alike(Array.from(media[1].content), [2, 2], 'second byte part follows')

  const text = items.find((item) => item.type === 'text')
  const parts = JSON.parse(text.input)[0].content
  t.alike(
    parts,
    [
      { type: 'text', text: 'A:' },
      { type: 'media' },
      { type: 'text', text: 'B:' },
      { type: 'media', content: 'images/b.jpg' },
      { type: 'text', text: 'C:' },
      { type: 'media' }
    ],
    'part order is kept; byte parts carry no payload, path parts keep their path'
  )
})

test('ordered parts: malformed parts reach the native validator instead of throwing a TypeError', async (t) => {
  for (const bad of [null, 7, 'text']) {
    const { model, sent } = createModel()
    await model.run([{ role: 'user', content: [bad] }])
    const text = sent[0].find((item) => item.type === 'text')
    t.alike(JSON.parse(text.input)[0].content, [bad], `${String(bad)} part is forwarded unchanged`)
  }
})
