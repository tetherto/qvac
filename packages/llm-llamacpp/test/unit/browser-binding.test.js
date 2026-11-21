'use strict'

const test = require('brittle')
const binding = require('../../binding.browser.js')

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

test('browser binding cleans cancelled jobs when an output listener throws', async (t) => {
  const handle = instance(() => {
    throw new Error('listener failed')
  })

  for (let iteration = 0; iteration < 20; iteration++) {
    const admission = await binding.runJob(handle, [{ type: 'text', input: '[]' }])
    await binding.cancelJob(handle, admission.id)
    await delay()
    t.is(binding.activeJobs(handle), 0, `iteration ${iteration + 1}`)
  }
})

test('browser binding reports worker-wide jobs to every model', async (t) => {
  const first = instance()
  const second = instance()

  for (let iteration = 0; iteration < 20; iteration++) {
    const admission = await binding.runJob(first, [{ type: 'text', input: '[]' }])
    t.is(binding.activeJobs(second), 1, `iteration ${iteration + 1}`)
    await binding.cancelJob(first, admission.id)
    await delay()
    t.is(binding.activeJobs(second), 0, `settled iteration ${iteration + 1}`)
  }
})

test('browser binding rejects path and ordered-part media before admission', async (t) => {
  const handle = instance()
  const prompts = [
    [{ role: 'user', type: 'media', content: '/image.png' }],
    [
      {
        role: 'user',
        content: [
          { type: 'text', content: 'Describe this' },
          { type: 'media', content: '/image.png' }
        ]
      }
    ]
  ]

  for (let iteration = 0; iteration < 20; iteration++) {
    for (const prompt of prompts) {
      await t.exception.all(
        () => binding.runJob(handle, [{ type: 'text', input: JSON.stringify(prompt) }]),
        /Media input is not supported/
      )
      t.is(binding.activeJobs(handle), 0)
    }
  }
})

test('browser binding rejects projection models before loading the engine', async (t) => {
  const handle = binding.createInstance(
    {},
    { path: '/model.gguf', projectionPath: '/projection.gguf' },
    () => {}
  )

  await t.exception.all(() => binding.activate(handle), /Projection model is not supported/)
  t.is(binding.activeJobs(handle), 0)
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
