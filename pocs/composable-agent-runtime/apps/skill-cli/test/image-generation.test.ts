import { expect, test } from 'bun:test'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import {
  createImageGenerationTooling,
  type ImageAttachmentFileSystem,
  type ImageGenerationTooling
} from '../lib/image-generation.ts'
import type {
  SdkImageGenerationInput,
  SdkRuntimePort
} from '@qvac/harness/skill-host'
import type {
  AgentToolInvocation as HarnessToolInvocation
} from '@qvac/agents'

const PNG = png(512, 512)

interface FakeSdkControls {
  readonly inputs: SdkImageGenerationInput[]
  readonly cancelled: string[]
  result:
    | {
        readonly status: 'success'
        readonly image: Uint8Array
        readonly stats: Readonly<Record<string, number>>
      }
    | { readonly status: 'busy'; readonly message: string }
  generate?: (input: SdkImageGenerationInput) => Promise<FakeSdkControls['result']>
}

type FailingOperation = 'write' | 'sync' | 'chmod' | 'rename'

function createFakeSdk(): { readonly sdk: SdkRuntimePort; readonly controls: FakeSdkControls } {
  const controls: FakeSdkControls = {
    inputs: [],
    cancelled: [],
    result: {
      status: 'success',
      image: PNG,
      stats: { generationMs: 12 }
    }
  }
  const sdk: SdkRuntimePort = {
    loadModel: async ({ model }) => ({ modelId: model }),
    completion: ({ requestId }) => ({
      requestId,
      events: (async function* () {})()
    }),
    async generateImage(input) {
      controls.inputs.push(input)
      return controls.generate ? controls.generate(input) : controls.result
    },
    async cancel({ requestId }) {
      controls.cancelled.push(requestId)
    },
    heartbeat: async () => ({ ok: true }),
    close: async () => {}
  }
  return { sdk, controls }
}

async function createRoot() {
  const created = await fs.mkdtemp(path.join(os.tmpdir(), 'qvac-image-test-'))
  const parent = await fs.realpath(created)
  return { parent, root: path.join(parent, 'attachments') }
}

function invocation(
  arguments_: Record<string, string | number>,
  signal = new AbortController().signal,
  reportProgress?: HarnessToolInvocation['reportProgress']
): HarnessToolInvocation {
  return {
    agentId: 'image-agent',
    runId: 'image-run',
    operationId: 'image-operation',
    call: {
      id: `image-call-${Math.random().toString(36).slice(2)}`,
      name: 'generate_image',
      arguments: arguments_
    },
    grants: [{ name: 'generate_image', scope: null }],
    signal,
    ...(reportProgress ? { reportProgress } : {})
  }
}

function imageToolingFactory() {
  return createImageGenerationTooling
}

function failingFileSystem(operation: FailingOperation): ImageAttachmentFileSystem {
  return {
    async open(filePath, flags, mode) {
      const handle = await fs.open(filePath, flags, mode)
      return {
        async write(image, offset, length, position) {
          if (operation === 'write') throw new Error('write failed')
          return handle.write(image, offset, length, position)
        },
        async sync() {
          if (operation === 'sync') throw new Error('sync failed')
          await handle.sync()
        },
        async close() {
          await handle.close()
        }
      }
    },
    async chmod(filePath, mode) {
      if (operation === 'chmod') throw new Error('chmod failed')
      await fs.chmod(filePath, mode)
    },
    async rename(source, destination) {
      if (operation === 'rename') throw new Error('rename failed')
      await fs.rename(source, destination)
    }
  }
}

async function treeEntries(root: string, relative = ''): Promise<string[]> {
  const directory = path.join(root, relative)
  const entries = await fs.readdir(directory, { withFileTypes: true })
  const result: string[] = []
  for (const entry of entries) {
    const child = path.join(relative, entry.name)
    result.push(child)
    if (entry.isDirectory()) result.push(...await treeEntries(root, child))
  }
  return result
}

async function attachmentArtifacts(root: string) {
  return (await treeEntries(root)).filter(
    (entry) => entry.endsWith('.png') || entry.includes('.partial')
  )
}

function png(width: number, height: number) {
  const bytes = new Uint8Array(24)
  bytes.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
  const view = new DataView(bytes.buffer)
  view.setUint32(8, 13)
  bytes.set([0x49, 0x48, 0x44, 0x52], 12)
  view.setUint32(16, width)
  view.setUint32(20, height)
  return bytes
}

async function expectAttachmentOperationFailure(operation: FailingOperation) {
  const { sdk } = createFakeSdk()
  const { parent, root } = await createRoot()
  await fs.mkdir(path.join(root, 'unrelated', 'nested'), { recursive: true })
  await fs.writeFile(path.join(root, 'keep.txt'), 'keep')
  await fs.writeFile(path.join(root, 'unrelated', 'nested', 'keep.txt'), 'nested')
  let tooling: ImageGenerationTooling | undefined
  try {
    tooling = await imageToolingFactory()({
      sdk,
      attachmentRoot: root,
      fileSystem: failingFileSystem(operation)
    })

    await expect(
      tooling.broker.execute(invocation({ prompt: 'sky' }))
    ).rejects.toThrow(`${operation} failed`)
    expect(await fs.readFile(path.join(root, 'keep.txt'), 'utf8')).toBe('keep')
    expect(
      await fs.readFile(path.join(root, 'unrelated', 'nested', 'keep.txt'), 'utf8')
    ).toBe('nested')
    expect(await attachmentArtifacts(root)).toEqual([])
  } finally {
    await tooling?.close()
    await fs.rm(parent, { recursive: true, force: true })
  }
}

test('exports one generate_image tool backed by the shared SDK broker', async () => {
  const { sdk } = createFakeSdk()
  const { parent, root } = await createRoot()
  const tooling = await imageToolingFactory()({ sdk, attachmentRoot: root })

  expect(tooling.tools.map((tool) => tool.schema.name)).toEqual(['generate_image'])

  await tooling.close()
  await fs.rm(parent, { recursive: true, force: true })
})

test('validates text-to-image arguments and snaps dimensions to the 64 grid', async () => {
  const { sdk, controls } = createFakeSdk()
  controls.result = {
    status: 'success',
    image: png(64, 1024),
    stats: { generationMs: 12 }
  }
  const { parent, root } = await createRoot()
  const tooling = await imageToolingFactory()({ sdk, attachmentRoot: root })

  await tooling.broker.execute(invocation({
    prompt: '  a quiet sky  ',
    negative_prompt: 'noise',
    width: 65,
    height: 1023,
    steps: 1,
    seed: 0xffffffff
  }))

  expect(controls.inputs).toHaveLength(1)
  expect(controls.inputs[0]).toMatchObject({
    prompt: 'a quiet sky',
    negativePrompt: 'noise',
    width: 64,
    height: 1024,
    steps: 1,
    seed: 0xffffffff
  })

  await tooling.close()
  await fs.rm(parent, { recursive: true, force: true })
})

test('defaults image dimensions to 512', async () => {
  const { sdk, controls } = createFakeSdk()
  const { parent, root } = await createRoot()
  const tooling = await imageToolingFactory()({ sdk, attachmentRoot: root })

  await tooling.broker.execute(invocation({ prompt: 'sky' }))

  expect(controls.inputs[0]).toMatchObject({ width: 512, height: 512 })
  await tooling.close()
  await fs.rm(parent, { recursive: true, force: true })
})

test('rejects PNG output whose IHDR dimensions differ from the request', async () => {
  const { sdk, controls } = createFakeSdk()
  controls.result = {
    status: 'success',
    image: png(64, 128),
    stats: {}
  }
  const { parent, root } = await createRoot()
  const tooling = await imageToolingFactory()({ sdk, attachmentRoot: root })

  await expect(
    tooling.broker.execute(
      invocation({ prompt: 'sky', width: 512, height: 512 })
    )
  ).rejects.toThrow(/IHDR dimensions.*64x128.*512x512/i)
  expect(await attachmentArtifacts(root)).toEqual([])

  await tooling.close()
  await fs.rm(parent, { recursive: true, force: true })
})

test('rejects unknown and edit-image fields before SDK execution', async () => {
  const { sdk, controls } = createFakeSdk()
  const { parent, root } = await createRoot()
  const tooling = await imageToolingFactory()({ sdk, attachmentRoot: root })

  await expect(
    tooling.broker.execute(invocation({ prompt: 'sky', init_image: 'bytes' }))
  ).rejects.toThrow(/unknown field.*init_image/i)
  await expect(
    tooling.broker.execute(invocation({ prompt: 'sky', strength: 0.5 }))
  ).rejects.toThrow(/unknown field.*strength/i)
  await expect(
    tooling.broker.execute(invocation({ prompt: 'sky', edit_image: 'x' }))
  ).rejects.toThrow(/unknown field.*edit_image/i)
  expect(controls.inputs).toHaveLength(0)

  await tooling.close()
  await fs.rm(parent, { recursive: true, force: true })
})

test('rejects invalid prompts, numeric types, and numeric bounds', async () => {
  const { sdk, controls } = createFakeSdk()
  const { parent, root } = await createRoot()
  const tooling = await imageToolingFactory()({ sdk, attachmentRoot: root })

  await expect(tooling.broker.execute(invocation({ prompt: ' ' }))).rejects.toThrow(/prompt/i)
  await expect(
    tooling.broker.execute(invocation({ prompt: 'x', width: 63 }))
  ).rejects.toThrow(/width/i)
  await expect(
    tooling.broker.execute(invocation({ prompt: 'x', height: 512.5 }))
  ).rejects.toThrow(/height/i)
  await expect(
    tooling.broker.execute(invocation({ prompt: 'x', steps: 101 }))
  ).rejects.toThrow(/steps/i)
  await expect(
    tooling.broker.execute(invocation({ prompt: 'x', seed: 0x100000000 }))
  ).rejects.toThrow(/seed/i)
  expect(controls.inputs).toHaveLength(0)

  await tooling.close()
  await fs.rm(parent, { recursive: true, force: true })
})

test('returns a clear busy result without creating an attachment', async () => {
  const { sdk, controls } = createFakeSdk()
  controls.result = { status: 'busy', message: 'diffusion generation is already active' }
  const { parent, root } = await createRoot()
  const tooling = await imageToolingFactory()({ sdk, attachmentRoot: root })

  const result = await tooling.broker.execute(invocation({ prompt: 'sky' }))

  expect(result).toEqual({
    status: 'busy',
    message: 'diffusion generation is already active'
  })
  expect(await attachmentArtifacts(root)).toEqual([])
  await tooling.close()
  await fs.rm(parent, { recursive: true, force: true })
})

test('emits ordered bounded progress without image bytes', async () => {
  const { sdk, controls } = createFakeSdk()
  controls.generate = async (input) => {
    for (let step = 1; step <= 140; step++) {
      await input.onProgress({ step, totalSteps: 140, elapsedMs: step * 2 })
    }
    return controls.result
  }
  const progress: unknown[] = []
  const { parent, root } = await createRoot()
  const tooling = await imageToolingFactory()({ sdk, attachmentRoot: root })

  await tooling.broker.execute(invocation(
    { prompt: 'sky' },
    new AbortController().signal,
    async (event) => {
      progress.push(event)
    }
  ))

  expect(progress.length).toBeLessThanOrEqual(100)
  expect(progress.map((entry) => Reflect.get(entry as object, 'step'))).toEqual(
    [...progress]
      .map((entry) => Reflect.get(entry as object, 'step'))
      .sort((a, b) => a - b)
  )
  expect(JSON.stringify(progress)).not.toContain('89504e47')
  await tooling.close()
  await fs.rm(parent, { recursive: true, force: true })
})

test('cancellation reaches SDK and fences late progress and results', async () => {
  const { sdk, controls } = createFakeSdk()
  let release: (() => void) | undefined
  controls.generate = async (input) => {
    await input.onProgress({ step: 1, totalSteps: 2, elapsedMs: 1 })
    await new Promise<void>((resolve) => {
      release = resolve
    })
    await input.onProgress({ step: 2, totalSteps: 2, elapsedMs: 2 })
    return controls.result
  }
  const progress: unknown[] = []
  const { parent, root } = await createRoot()
  const tooling = await imageToolingFactory()({ sdk, attachmentRoot: root })
  const input = invocation(
    { prompt: 'sky' },
    new AbortController().signal,
    async (event) => {
      progress.push(event)
    }
  )
  const executing = tooling.broker.execute(input)
  while (!release) await Bun.sleep(1)

  await tooling.broker.cancel(input)
  release()

  await expect(executing).rejects.toThrow(/cancel/i)
  expect(controls.cancelled).toEqual([input.call.id])
  expect(progress).toHaveLength(1)
  expect(await attachmentArtifacts(root)).toEqual([])
  await tooling.close()
  await fs.rm(parent, { recursive: true, force: true })
})

test('persists opaque owner-only PNG attachments atomically', async () => {
  const { sdk } = createFakeSdk()
  const { parent, root } = await createRoot()
  const tooling = await imageToolingFactory()({ sdk, attachmentRoot: root })
  const prompt = 'secret prompt words'

  const result = await tooling.broker.execute(invocation({ prompt })) as {
    readonly status: string
    readonly attachment: {
      readonly id: string
      readonly path: string
      readonly mimeType: string
      readonly byteLength: number
      readonly width: number
      readonly height: number
    }
  }
  const runDirectory = path.dirname(result.attachment.path)

  expect(result).toMatchObject({
    status: 'success',
    attachment: {
      mimeType: 'image/png',
      byteLength: PNG.byteLength,
      width: 512,
      height: 512
    }
  })
  expect(result).not.toHaveProperty('image')
  expect(JSON.stringify(result)).not.toContain(JSON.stringify([...PNG]))
  expect(path.isAbsolute(result.attachment.path)).toBe(true)
  expect(result.attachment.path).not.toContain('secret')
  expect(result.attachment.path).not.toContain('prompt')
  expect([
    ...(await fs.readFile(result.attachment.path)).subarray(0, 8)
  ]).toEqual([...PNG.subarray(0, 8)])
  expect((await fs.stat(root)).mode & 0o777).toBe(0o700)
  expect((await fs.stat(runDirectory)).mode & 0o777).toBe(0o700)
  expect((await fs.stat(result.attachment.path)).mode & 0o777).toBe(0o600)
  expect((await fs.readdir(runDirectory)).every((name) => !name.includes('.partial'))).toBe(true)

  await expect(fs.stat(result.attachment.path)).resolves.toBeDefined()
  await tooling.cleanupAttachments()
  await expect(fs.stat(result.attachment.path)).rejects.toMatchObject({ code: 'ENOENT' })
  await fs.rm(parent, { recursive: true, force: true })
})

test('cleanup removes only the runtime-owned namespace contents', async () => {
  const { sdk } = createFakeSdk()
  const { parent, root } = await createRoot()
  await fs.mkdir(path.join(root, 'unrelated', 'nested'), { recursive: true })
  await fs.writeFile(path.join(root, 'keep.txt'), 'keep')
  await fs.writeFile(path.join(root, 'unrelated', 'nested', 'keep.txt'), 'nested')
  const tooling = await imageToolingFactory()({ sdk, attachmentRoot: root })
  const result = await tooling.broker.execute(invocation({ prompt: 'sky' })) as {
    readonly attachment: { readonly path: string }
  }

  await tooling.cleanupAttachments()

  expect(await fs.readFile(path.join(root, 'keep.txt'), 'utf8')).toBe('keep')
  expect(
    await fs.readFile(path.join(root, 'unrelated', 'nested', 'keep.txt'), 'utf8')
  ).toBe('nested')
  await expect(fs.stat(result.attachment.path)).rejects.toMatchObject({ code: 'ENOENT' })
  expect(await attachmentArtifacts(root)).toEqual([])
  await tooling.close()
  await fs.rm(parent, { recursive: true, force: true })
})

test('rejects a symlink in a configured base parent component', async () => {
  const { sdk } = createFakeSdk()
  const created = await fs.mkdtemp(
    path.join(os.tmpdir(), 'qvac-image-parent-link-')
  )
  const parent = await fs.realpath(created)
  const realParent = path.join(parent, 'real')
  const linkedParent = path.join(parent, 'linked')
  await fs.mkdir(realParent)
  await fs.symlink(realParent, linkedParent)

  await expect(
    imageToolingFactory()({
      sdk,
      attachmentRoot: path.join(linkedParent, 'attachments')
    })
  ).rejects.toThrow(/symlink/i)
  expect(await fs.readdir(realParent)).toEqual([])
  await fs.rm(parent, { recursive: true, force: true })
})

test('rejects a symlink in the final configured base component', async () => {
  const { sdk } = createFakeSdk()
  const { parent } = await createRoot()
  const target = path.join(parent, 'target')
  const root = path.join(parent, 'attachments-link')
  await fs.mkdir(target)
  await fs.writeFile(path.join(target, 'keep.txt'), 'keep')
  await fs.symlink(target, root)

  await expect(imageToolingFactory()({ sdk, attachmentRoot: root })).rejects.toThrow(/symlink/i)
  expect(await fs.readFile(path.join(target, 'keep.txt'), 'utf8')).toBe('keep')
  await fs.rm(parent, { recursive: true, force: true })
})

test('write failure removes owned attachment artifacts only', async () => {
  await expectAttachmentOperationFailure('write')
})

test('sync failure removes owned attachment artifacts only', async () => {
  await expectAttachmentOperationFailure('sync')
})

test('chmod failure removes owned attachment artifacts only', async () => {
  await expectAttachmentOperationFailure('chmod')
})

test('rename failure removes owned attachment artifacts only', async () => {
  await expectAttachmentOperationFailure('rename')
})

test('rejects invalid and oversized PNG output without partial files', async () => {
  const { sdk, controls } = createFakeSdk()
  const { parent, root } = await createRoot()
  const tooling = await imageToolingFactory()({ sdk, attachmentRoot: root })
  controls.result = {
    status: 'success',
    image: new Uint8Array([1, 2, 3]),
    stats: {}
  }

  await expect(tooling.broker.execute(invocation({ prompt: 'sky' }))).rejects.toThrow(/PNG signature/i)
  expect(await attachmentArtifacts(root)).toEqual([])

  const oversized = new Uint8Array(64 * 1024 * 1024 + 1)
  oversized.set(PNG.subarray(0, 8))
  controls.result = { status: 'success', image: oversized, stats: {} }
  await expect(tooling.broker.execute(invocation({ prompt: 'sky' }))).rejects.toThrow(/64 MiB/i)
  expect(await attachmentArtifacts(root)).toEqual([])

  await tooling.close()
  await fs.rm(parent, { recursive: true, force: true })
})

test('failed generation leaves no partial attachment', async () => {
  const { sdk, controls } = createFakeSdk()
  controls.generate = async () => {
    throw new Error('native generation failed')
  }
  const { parent, root } = await createRoot()
  const tooling = await imageToolingFactory()({ sdk, attachmentRoot: root })

  await expect(tooling.broker.execute(invocation({ prompt: 'sky' }))).rejects.toThrow(
    'native generation failed'
  )
  expect(await attachmentArtifacts(root)).toEqual([])

  await tooling.close()
  await fs.rm(parent, { recursive: true, force: true })
})
