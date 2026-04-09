'use strict'

const test = require('brittle')

const { SdInterface } = require('../../addon')

test('runJob forwards lora in JSON payload', async t => {
  let capturedInput = null

  const binding = {
    createInstance () {
      return { id: 'fake-handle' }
    },
    runJob (_handle, input) {
      capturedInput = input
      return true
    },
    destroyInstance () {},
    activate () {},
    cancel () {}
  }

  const addon = new SdInterface(
    binding,
    {
      path: '/tmp/model.gguf',
      config: {}
    },
    () => {}
  )

  const accepted = await addon.runJob({
    mode: 'txt2img',
    prompt: 'a fox in snow',
    lora: '/tmp/adapter.safetensors',
    steps: 2
  })

  t.is(accepted, true, 'job is accepted')
  t.alike(capturedInput && capturedInput.type, 'text', 'runJob uses text bridge input')
  t.ok(capturedInput && typeof capturedInput.input === 'string', 'runJob serializes params as JSON')

  const params = JSON.parse(capturedInput.input)
  t.is(params.mode, 'txt2img', 'mode is preserved')
  t.is(params.prompt, 'a fox in snow', 'prompt is preserved')
  t.is(params.lora, '/tmp/adapter.safetensors', 'lora path is preserved')
  t.is(params.steps, 2, 'other params remain intact')
})
