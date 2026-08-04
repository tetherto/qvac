import { expect, mock, test } from 'bun:test'

const loadInputs: Array<{
  readonly modelSrc: string
  readonly modelType: string
  readonly modelConfig?: {
    readonly tools?: boolean
    readonly ctx_size?: number
    readonly prediction?: string
  }
}> = []
const llmPlugin = { name: 'llm' }
const diffusionPlugin = { name: 'diffusion' }
const pluginRegistrations: object[][] = []
const cancelInputs: object[] = []
const unloadInputs: object[] = []
let sdkCloses = 0
let completionEvents: Array<{
  readonly type: 'completionDone'
  readonly raw?: { readonly fullText: string }
}> = []

interface FakeDiffusionRun {
  readonly progressStream: AsyncIterable<{
    readonly step: number
    readonly totalSteps: number
    readonly elapsedMs: number
  }>
  readonly outputs: Promise<Uint8Array[]>
  readonly stats: Promise<
    Readonly<Record<string, number | string | undefined>> | undefined
  >
}

let diffusionFactory: (input: object) => FakeDiffusionRun = () => ({
  progressStream: (async function* () {
    yield { step: 1, totalSteps: 1, elapsedMs: 3 }
  })(),
  outputs: Promise.resolve([new Uint8Array([1, 2, 3])]),
  stats: Promise.resolve({
    generationMs: 3,
    width: 512,
    height: 512,
    ignored: 'not numeric'
  })
})

mock.module('@qvac/sdk', () => ({
  close: async () => {
    sdkCloses++
  },
  plugins: (registered: object[]) => {
    pluginRegistrations.push(registered)
    return {
      async loadModel(input: {
        readonly modelSrc: string
        readonly modelType: string
        readonly modelConfig?: {
          readonly tools?: boolean
          readonly prediction?: string
        }
      }) {
        loadInputs.push(input)
        if (input.modelType === 'sdcpp-generation') return 'diffusion-model'
        return input.modelConfig?.tools ? 'tool-model' : 'plain-model'
      },
      completion() {
        return {
          requestId: 'unused',
          events: (async function* () {
            yield* completionEvents
          })()
        }
      },
      diffusion(input: object) {
        return diffusionFactory(input)
      },
      async unloadModel(input: object) {
        unloadInputs.push(input)
      },
      async cancel(input: object) {
        cancelInputs.push(input)
      },
      heartbeat: async () => ({})
    }
  }
}))

mock.module('@qvac/sdk/llamacpp-completion/plugin', () => ({
  llmPlugin
}))

mock.module('@qvac/sdk/sdcpp-generation/plugin', () => ({
  diffusionPlugin
}))

const { createSdkDirectAdapter } = await import('../lib/sdk-direct-adapter.ts')

test('tool-capable loads enable tools without reusing a schema-free model', async () => {
  const adapter = await createSdkDirectAdapter()
  const plainLoad = { model: '/model.gguf', traceId: 'plain' }
  const toolLoad = { model: '/model.gguf', traceId: 'tools', toolSupport: true }

  const plain = await adapter.loadModel(plainLoad)
  const toolCapable = await adapter.loadModel(toolLoad)

  expect(loadInputs.map((input) => input.modelConfig)).toEqual([
    undefined,
    { tools: true, ctx_size: 4096 }
  ])
  expect(plain.modelId).toBe('plain-model')
  expect(toolCapable.modelId).toBe('tool-model')
})

test('completion forwards canonical raw output through the runtime port', async () => {
  const canonicalRaw = '<tool_call>verbatim</tool_call>'
  completionEvents = [{
    type: 'completionDone',
    raw: { fullText: canonicalRaw }
  }]
  const adapter = await createSdkDirectAdapter()
  const completion = adapter.completion({
    requestId: 'raw',
    traceId: 'raw',
    modelId: 'tool-model',
    messages: [],
    signal: new AbortController().signal,
    tools: []
  })
  const events = []
  for await (const event of completion.events) events.push(event)

  expect(events).toEqual([{
    type: 'completion-done',
    raw: { fullText: canonicalRaw }
  }])
})

test('one SDK plugin registry contains both LLM and diffusion plugins', async () => {
  const before = pluginRegistrations.length
  const adapter = await createSdkDirectAdapter()

  expect(pluginRegistrations.slice(before)).toEqual([[llmPlugin, diffusionPlugin]])
  await adapter.close()
})

test('diffusion model lazy-loads once and remains resident across generations', async () => {
  const beforeLoads = loadInputs.length
  const progress: object[] = []
  const adapter = await createSdkDirectAdapter({
    diffusion: {
      model: '/models/sd.gguf',
      modelConfig: { prediction: 'v' }
    }
  })
  const input = {
    requestId: 'image-one',
    traceId: 'image-one',
    prompt: 'sky',
    width: 512,
    height: 512,
    signal: new AbortController().signal,
    async onProgress(event: object) {
      progress.push(event)
    }
  }

  const first = await adapter.generateImage(input)
  const second = await adapter.generateImage({ ...input, requestId: 'image-two' })

  expect(first).toMatchObject({
    status: 'success',
    image: new Uint8Array([1, 2, 3]),
    stats: { generationMs: 3, width: 512, height: 512 }
  })
  expect(second.status).toBe('success')
  expect(loadInputs.slice(beforeLoads)).toEqual([{
    modelSrc: '/models/sd.gguf',
    modelType: 'sdcpp-generation',
    modelConfig: { prediction: 'v' }
  }])
  expect(progress).toEqual([
    { step: 1, totalSteps: 1, elapsedMs: 3 },
    { step: 1, totalSteps: 1, elapsedMs: 3 }
  ])
  await adapter.close()
})

test('diffusion generation is single-flight and reports busy', async () => {
  let release: (() => void) | undefined
  diffusionFactory = () => ({
    progressStream: (async function* () {})(),
    outputs: new Promise<Uint8Array[]>((resolve) => {
      release = () => resolve([new Uint8Array([4])])
    }),
    stats: Promise.resolve({})
  })
  const adapter = await createSdkDirectAdapter({
    diffusion: { model: '/models/sd.gguf' }
  })
  const input = {
    requestId: 'active-image',
    traceId: 'active-image',
    prompt: 'sky',
    width: 512,
    height: 512,
    signal: new AbortController().signal,
    async onProgress() {}
  }

  const active = adapter.generateImage(input)
  while (!release) await Bun.sleep(1)
  const busy = await adapter.generateImage({ ...input, requestId: 'busy-image' })
  release()

  expect(busy).toEqual({
    status: 'busy',
    message: 'diffusion generation is already active'
  })
  expect((await active).status).toBe('success')
  await adapter.close()
})

test('diffusion cancellation reaches the SDK and fences late progress and output', async () => {
  let release: (() => void) | undefined
  diffusionFactory = () => ({
    progressStream: (async function* () {
      yield { step: 1, totalSteps: 2, elapsedMs: 1 }
      await new Promise<void>((resolve) => {
        release = resolve
      })
      yield { step: 2, totalSteps: 2, elapsedMs: 2 }
    })(),
    outputs: Promise.resolve([new Uint8Array([5])]),
    stats: Promise.resolve({})
  })
  const progress: object[] = []
  const adapter = await createSdkDirectAdapter({
    diffusion: { model: '/models/sd.gguf' }
  })
  const generating = adapter.generateImage({
    requestId: 'cancel-image',
    traceId: 'cancel-image',
    prompt: 'sky',
    width: 512,
    height: 512,
    signal: new AbortController().signal,
    async onProgress(event: object) {
      progress.push(event)
    }
  })
  while (!release) await Bun.sleep(1)

  await adapter.cancel({ requestId: 'cancel-image' })
  release()

  await expect(generating).rejects.toThrow(/cancel/i)
  expect(cancelInputs).toContainEqual({
    modelId: 'diffusion-model',
    kind: 'diffusion'
  })
  expect(progress).toEqual([{ step: 1, totalSteps: 2, elapsedMs: 1 }])
  await adapter.close()
})

test('failed diffusion keeps its lazy-loaded model resident for retry', async () => {
  let attempts = 0
  diffusionFactory = () => {
    attempts++
    return {
      progressStream: (async function* () {})(),
      outputs:
        attempts === 1
          ? Promise.reject(new Error('native diffusion failed'))
          : Promise.resolve([new Uint8Array([7])]),
      stats: Promise.resolve({})
    }
  }
  const beforeLoads = loadInputs.length
  const adapter = await createSdkDirectAdapter({
    diffusion: { model: '/models/sd.gguf' }
  })
  const input = {
    requestId: 'failure-image',
    traceId: 'failure-image',
    prompt: 'sky',
    width: 512,
    height: 512,
    signal: new AbortController().signal,
    async onProgress() {}
  }

  await expect(adapter.generateImage(input)).rejects.toThrow('native diffusion failed')
  expect(
    (await adapter.generateImage({ ...input, requestId: 'retry-image' })).status
  ).toBe('success')
  expect(loadInputs.slice(beforeLoads)).toHaveLength(1)
  await adapter.close()
})

test('output failure keeps diffusion busy until stats and progress settle', async () => {
  let attempts = 0
  let releaseProgress: (() => void) | undefined
  diffusionFactory = () => {
    attempts++
    if (attempts > 1) {
      return {
        progressStream: (async function* () {})(),
        outputs: Promise.resolve([new Uint8Array([8])]),
        stats: Promise.resolve({})
      }
    }
    return {
      progressStream: (async function* () {
        await new Promise<void>((resolve) => {
          releaseProgress = resolve
        })
        throw new Error('progress failed after output')
      })(),
      outputs: Promise.reject(new Error('outputs failed first')),
      stats: Promise.reject(new Error('stats failed second'))
    }
  }
  const adapter = await createSdkDirectAdapter({
    diffusion: { model: '/models/sd.gguf' }
  })
  const input = {
    requestId: 'settlement-image',
    traceId: 'settlement-image',
    prompt: 'sky',
    width: 512,
    height: 512,
    signal: new AbortController().signal,
    async onProgress() {}
  }
  const firstFailure = adapter.generateImage(input).then(
    () => new Error('expected first generation to fail'),
    (error) => error instanceof Error ? error : new Error(String(error))
  )
  while (!releaseProgress) await Bun.sleep(1)
  await Bun.sleep(1)

  const concurrent = await adapter.generateImage({
    ...input,
    requestId: 'settlement-concurrent'
  })
  try {
    expect(concurrent).toEqual({
      status: 'busy',
      message: 'diffusion generation is already active'
    })
  } finally {
    releaseProgress()
  }

  expect((await firstFailure).message).toBe('outputs failed first')
  expect(
    (await adapter.generateImage({
      ...input,
      requestId: 'settlement-retry'
    })).status
  ).toBe('success')
  await adapter.close()
})

test('close unloads a resident diffusion model before closing the shared SDK', async () => {
  diffusionFactory = () => ({
    progressStream: (async function* () {})(),
    outputs: Promise.resolve([new Uint8Array([6])]),
    stats: Promise.resolve({})
  })
  const beforeUnloads = unloadInputs.length
  const beforeCloses = sdkCloses
  const adapter = await createSdkDirectAdapter({
    diffusion: { model: '/models/sd.gguf' }
  })

  await adapter.generateImage({
    requestId: 'close-image',
    traceId: 'close-image',
    prompt: 'sky',
    width: 512,
    height: 512,
    signal: new AbortController().signal,
    async onProgress() {}
  })
  await adapter.close()

  expect(unloadInputs.slice(beforeUnloads)).toEqual([{
    modelId: 'diffusion-model',
    clearStorage: false,
    autoClose: false
  }])
  expect(sdkCloses).toBe(beforeCloses + 1)
})
