'use strict'

const test = require('brittle')
const binding = require('../../binding.browser.js')
const {
  ensureMessageCacheDirectories,
  ensureParentDirectory
} = require('../../browser/cache-files.js')
const { prepareRunData } = require('../../browser/run-data.js')

function instance(output = () => {}) {
  return binding.createInstance({}, {}, output)
}

function delay() {
  return new Promise((resolve) => setTimeout(resolve, 10))
}

test('browser binding rolls back admission when serialization throws', (t) => {
  const handle = instance()
  const circular = {}
  circular.self = circular

  let error = null
  try {
    binding.runJob(handle, [{ type: 'text', input: '[]', generationParams: circular }])
  } catch (cause) {
    error = cause
  }
  t.ok(/circular/i.test(error?.message))
  t.is(binding.activeJobs(handle), 0)
})

test('browser binding rejects non-finite generation values before admission', (t) => {
  const handle = instance()
  const values = [NaN, Infinity, -Infinity]

  for (let iteration = 0; iteration < 20; iteration++) {
    for (const reasoningBudget of values) {
      let error = null
      try {
        binding.runJob(handle, [
          { type: 'text', input: '[]', generationParams: { reasoning_budget: reasoningBudget } }
        ])
      } catch (cause) {
        error = cause
      }
      t.ok(/reasoning_budget must be a finite number/.test(error?.message))
      t.is(binding.activeJobs(handle), 0)
    }
  }
})

test('browser cache paths create their private filesystem parents', (t) => {
  for (let iteration = 0; iteration < 20; iteration++) {
    const directories = []
    const module = { FS: { mkdirTree: (path) => directories.push(path) } }
    const messages = [
      { cacheKey: '/.qvac/cache/chat/model/config.bin' },
      { baseCacheKey: 'cache/base.bin' },
      { cacheKey: 'root.bin' },
      null
    ]
    const serialized = JSON.stringify(messages)
    messages[0].cacheKey = '/mutated/after-admission.bin'

    ensureMessageCacheDirectories(module, serialized)
    ensureParentDirectory(module, '/cache/manual.bin')
    ensureParentDirectory(module, '')

    t.alike(directories, ['/.qvac/cache/chat/model', '/cache'], `iteration ${iteration + 1}`)
  }
})

test('browser binding cleans explicitly cancelled jobs', async (t) => {
  const handle = instance()
  for (let iteration = 0; iteration < 20; iteration++) {
    const admission = await binding.runJob(handle, [{ type: 'text', input: '[]' }])
    await binding.cancelJob(handle, admission.id)
    await delay()
    t.is(binding.activeJobs(handle), 0, `iteration ${iteration + 1}`)
  }
})

test('browser binding reports jobs per model instance', async (t) => {
  const first = instance()
  const second = instance()

  for (let iteration = 0; iteration < 20; iteration++) {
    const admission = await binding.runJob(first, [{ type: 'text', input: '[]' }])
    t.is(binding.activeJobs(second), 0, `iteration ${iteration + 1}`)
    await binding.cancelJob(first, admission.id)
    await delay()
    t.is(binding.activeJobs(second), 0, `settled iteration ${iteration + 1}`)
  }
})

test('browser run data stages media bytes without JSON expansion', (t) => {
  for (let iteration = 0; iteration < 20; iteration++) {
    const first = new Uint8Array([0, 1, 127, 128, 254, 255])
    const second = new Uint8Array([9, 8, 7])
    const prepared = prepareRunData([
      { type: 'media', content: first },
      { type: 'media', content: second },
      { type: 'text', input: '[{"role":"user","type":"media","content":""}]' }
    ])

    t.alike(JSON.parse(prepared.json), [
      { type: 'text', input: '[{"role":"user","type":"media","content":""}]' }
    ])
    t.alike(prepared.media, [[first, second]], `iteration ${iteration + 1}`)
    t.ok(prepared.json.length < first.byteLength + second.byteLength + 100)
  }
})

test('browser run data preserves media grouping for a batch', (t) => {
  for (let iteration = 0; iteration < 20; iteration++) {
    const first = new Uint8Array([1, 2])
    const second = new Uint8Array([3, 4])
    const prepared = prepareRunData([
      {
        id: 'a',
        messages: [
          { type: 'media', content: first },
          { type: 'text', input: '[]' }
        ]
      },
      {
        id: 'b',
        messages: [
          { type: 'media', content: second },
          { type: 'text', input: '[]' }
        ]
      }
    ])

    t.alike(JSON.parse(prepared.json), [
      { id: 'a', messages: [{ type: 'text', input: '[]' }] },
      { id: 'b', messages: [{ type: 'text', input: '[]' }] }
    ])
    t.alike(prepared.media, [[first], [second]], `iteration ${iteration + 1}`)
    t.alike(prepared.ids, ['a', 'b'])
  }
})

test('browser run data preserves empty media groups before media prompts', (t) => {
  for (let iteration = 0; iteration < 20; iteration++) {
    const image = new Uint8Array([1, 2, 3])
    const prepared = prepareRunData([
      { id: 'text', messages: [{ type: 'text', input: '[]' }] },
      {
        id: 'image',
        messages: [
          { type: 'media', content: image },
          { type: 'text', input: '[]' }
        ]
      }
    ])
    t.alike(prepared.media, [[], [image]], `iteration ${iteration + 1}`)
  }
})

test('browser run data enforces native batch id rules', (t) => {
  for (let iteration = 0; iteration < 20; iteration++) {
    const first = prepareRunData([
      { messages: [{ type: 'text', input: '[]' }] },
      { id: `provided-${iteration}`, messages: [{ type: 'text', input: '[]' }] }
    ])
    const second = prepareRunData([{ messages: [{ type: 'text', input: '[]' }] }])
    t.ok(/^batch-\d+$/.test(first.ids[0]))
    t.is(first.ids[1], `provided-${iteration}`)
    t.unlike(first.ids[0], second.ids[0])

    const messages = []
    for (const run of [
      () =>
        prepareRunData([
          { id: 'same', messages: [] },
          { id: 'same', messages: [] }
        ]),
      () => prepareRunData([{ id: '', messages: [] }]),
      () => prepareRunData([{ id: `batch-${iteration}`, messages: [] }])
    ]) {
      try {
        run()
      } catch (error) {
        messages.push(error.message)
      }
    }
    t.alike(messages, [
      'Duplicate batch prompt id: same',
      'Batch prompt id must be a non-empty string when provided',
      `Batch prompt id prefix 'batch-' is reserved for auto-minted ids: batch-${iteration}`
    ])
  }
})

test('browser calcTokens fails fast while the engine queue is busy', async (t) => {
  const handle = instance()
  const admission = await binding.runJob(handle, [{ type: 'text', input: '[]' }])

  for (let iteration = 0; iteration < 20; iteration++) {
    let error = null
    try {
      await binding.calcTokens(handle, { text: 'hello' })
    } catch (cause) {
      error = cause
    }
    t.is(error?.code, 'RUN_BUSY', `iteration ${iteration + 1}`)
  }
  await binding.cancelJob(handle, admission.id)
  await delay()
  t.is(binding.activeJobs(handle), 0)
})
