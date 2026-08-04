import crypto from '#crypto'
import fs from '#fs-promises'
import path from '#path'
import type {
  AgentTool as HarnessTool,
  AgentToolInvocation as HarnessToolInvocation,
  AgentToolProgress as HarnessToolProgress,
  ToolBrokerPort as HarnessToolBrokerPort
} from '@qvac/agents'
import type {
  HarnessJsonValue,
  SdkImageGenerationInput,
  SdkRuntimePort
} from '@qvac/harness/skill-host'

const DEFAULT_DIMENSION = 512
const DIMENSION_GRID = 64
const MIN_DIMENSION = 64
const MAX_DIMENSION = 1024
const MAX_PROMPT_CHARS = 4000
const MAX_STEPS = 100
const MAX_SEED = 0xffffffff
const MAX_IMAGE_BYTES = 64 * 1024 * 1024
const MAX_PROGRESS_EVENTS = 100
const OWNERSHIP_MARKER = '.qvac-owner'
const PNG_SIGNATURE = new Uint8Array([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a
])
const ALLOWED_ARGUMENTS = new Set([
  'prompt',
  'negative_prompt',
  'width',
  'height',
  'steps',
  'seed'
])

interface ActiveGeneration {
  readonly requestId: string
  readonly scope: string
  cancelled: boolean
  settled?: Promise<HarnessJsonValue>
}

export interface ImageAttachmentFileHandle {
  write(
    image: Uint8Array,
    offset: number,
    length: number,
    position: number
  ): Promise<{ readonly bytesWritten: number }>
  sync(): Promise<void>
  close(): Promise<void>
}

export interface ImageAttachmentFileSystem {
  open(
    filePath: string,
    flags: 'wx',
    mode: number
  ): Promise<ImageAttachmentFileHandle>
  chmod(filePath: string, mode: number): Promise<void>
  rename(source: string, destination: string): Promise<void>
}

interface AttachmentNamespace {
  readonly baseComponents: readonly string[]
  readonly directory: string
  readonly marker: string
  readonly ownershipToken: string
}

export interface ImageGenerationTooling {
  readonly tools: readonly HarnessTool[]
  readonly broker: HarnessToolBrokerPort
  cleanupAttachments(): Promise<void>
  close(): Promise<void>
}

export async function createImageGenerationTooling(input: {
  readonly sdk: SdkRuntimePort
  readonly attachmentRoot: string
  readonly fileSystem?: ImageAttachmentFileSystem
}): Promise<ImageGenerationTooling> {
  const attachmentNamespace = await prepareAttachmentNamespace(
    input.attachmentRoot
  )
  const fileSystem = input.fileSystem ?? DEFAULT_ATTACHMENT_FILE_SYSTEM
  const active = new Map<string, ActiveGeneration>()
  let closed = false
  let closing: Promise<void> | undefined

  async function execute(invocation: HarnessToolInvocation) {
    if (closed) throw new Error('image generation tooling is closed')
    if (invocation.call.name !== 'generate_image') {
      throw new Error(`unknown shared SDK tool: ${invocation.call.name}`)
    }
    if (invocation.signal.aborted) throw new Error('image generation cancelled')
    const arguments_ = validateArguments(invocation.call.arguments)
    const scope = invocationKey(invocation)
    const key = `${scope}\0${invocation.call.id}`
    if (active.has(key)) {
      throw new Error(`duplicate image tool call: ${invocation.call.id}`)
    }
    const generation: ActiveGeneration = {
      requestId: invocation.call.id,
      scope,
      cancelled: false
    }
    active.set(key, generation)
    const settled = generateAndPersist(
      input.sdk,
      attachmentNamespace,
      fileSystem,
      invocation,
      arguments_,
      generation
    ).finally(() => {
      if (active.get(key) === generation) active.delete(key)
    })
    generation.settled = settled
    return settled
  }

  async function cancel(
    invocation: Pick<
      HarnessToolInvocation,
      'agentId' | 'runId' | 'operationId'
    >
  ) {
    const scope = invocationKey(invocation)
    const generations = [...active.values()].filter(
      (generation) => generation.scope === scope && !generation.cancelled
    )
    for (const generation of generations) generation.cancelled = true
    await Promise.all(
      generations.map((generation) =>
        input.sdk.cancel({ requestId: generation.requestId })
      )
    )
  }

  async function close() {
    if (closed) return
    closing ??= closeActive()
    await closing
  }

  async function closeActive() {
    closed = true
    const generations = [...active.values()]
    await Promise.allSettled(
      generations.map(async (generation) => {
        generation.cancelled = true
        await input.sdk.cancel({ requestId: generation.requestId })
      })
    )
    await Promise.allSettled(
      generations.flatMap((generation) =>
        generation.settled ? [generation.settled] : []
      )
    )
  }

  async function cleanupAttachments() {
    if (active.size > 0) {
      throw new Error('cannot clean attachments during image generation')
    }
    await verifyOwnedNamespace(attachmentNamespace)
    const entries = await fs.readdir(attachmentNamespace.directory)
    await Promise.all(
      entries
        .filter((entry) => entry !== OWNERSHIP_MARKER)
        .map((entry) =>
          fs.rm(path.join(attachmentNamespace.directory, entry), {
            recursive: true,
            force: true
          })
        )
    )
    await fs.chmod(attachmentNamespace.directory, 0o700)
  }

  const broker: HarnessToolBrokerPort = {
    execute,
    cancel,
    close
  }
  return {
    tools: [GENERATE_IMAGE_TOOL],
    broker,
    cleanupAttachments,
    close
  }
}

async function generateAndPersist(
  sdk: SdkRuntimePort,
  attachmentNamespace: AttachmentNamespace,
  fileSystem: ImageAttachmentFileSystem,
  invocation: HarnessToolInvocation,
  arguments_: ValidatedArguments,
  generation: ActiveGeneration
): Promise<HarnessJsonValue> {
  let lastStep = 0
  let progressEvents = 0
  const sdkInput: SdkImageGenerationInput = {
    requestId: generation.requestId,
    traceId: invocation.operationId,
    prompt: arguments_.prompt,
    ...(arguments_.negativePrompt !== undefined
      ? { negativePrompt: arguments_.negativePrompt }
      : {}),
    width: arguments_.width,
    height: arguments_.height,
    ...(arguments_.steps !== undefined ? { steps: arguments_.steps } : {}),
    ...(arguments_.seed !== undefined ? { seed: arguments_.seed } : {}),
    signal: invocation.signal,
    async onProgress(progress) {
      if (
        generation.cancelled ||
        invocation.signal.aborted ||
        progressEvents >= MAX_PROGRESS_EVENTS ||
        !validProgress(progress) ||
        progress.step <= lastStep
      ) {
        return
      }
      lastStep = progress.step
      progressEvents++
      await invocation.reportProgress?.(progress)
    }
  }
  const result = await sdk.generateImage(sdkInput)
  if (generation.cancelled || invocation.signal.aborted) {
    throw new Error('image generation cancelled')
  }
  if (result.status === 'busy') {
    return {
      status: 'busy',
      message: result.message
    }
  }
  const attachment = await persistPng(
    attachmentNamespace,
    fileSystem,
    result.image,
    arguments_.width,
    arguments_.height
  )
  if (generation.cancelled || invocation.signal.aborted) {
    await fs.rm(attachment.path, { force: true })
    await fs.rm(path.dirname(attachment.path), {
      recursive: true,
      force: true
    })
    throw new Error('image generation cancelled')
  }
  return {
    status: 'success',
    attachment,
    stats: { ...result.stats }
  }
}

interface ValidatedArguments {
  readonly prompt: string
  readonly negativePrompt?: string
  readonly width: number
  readonly height: number
  readonly steps?: number
  readonly seed?: number
}

function validateArguments(
  input: Readonly<Record<string, HarnessJsonValue>>
): ValidatedArguments {
  for (const field of Object.keys(input)) {
    if (!ALLOWED_ARGUMENTS.has(field)) {
      throw new Error(`unknown field for generate_image: ${field}`)
    }
  }
  const prompt = boundedString(input.prompt, 'prompt', false)
  const negativePrompt =
    input.negative_prompt === undefined
      ? undefined
      : boundedString(input.negative_prompt, 'negative_prompt', true)
  const width = dimension(input.width, 'width')
  const height = dimension(input.height, 'height')
  const steps =
    input.steps === undefined
      ? undefined
      : boundedInteger(input.steps, 'steps', 1, MAX_STEPS)
  const seed =
    input.seed === undefined
      ? undefined
      : boundedInteger(input.seed, 'seed', -1, MAX_SEED)
  return {
    prompt,
    ...(negativePrompt !== undefined ? { negativePrompt } : {}),
    width,
    height,
    ...(steps !== undefined ? { steps } : {}),
    ...(seed !== undefined ? { seed } : {})
  }
}

function boundedString(
  value: HarnessJsonValue | undefined,
  name: string,
  allowEmpty: boolean
) {
  if (typeof value !== 'string') throw new Error(`${name} must be a string`)
  const normalized = value.trim()
  if (!allowEmpty && normalized.length === 0) {
    throw new Error(`${name} must not be empty`)
  }
  if (normalized.length > MAX_PROMPT_CHARS) {
    throw new Error(`${name} must be at most ${MAX_PROMPT_CHARS} characters`)
  }
  return normalized
}

function dimension(value: HarnessJsonValue | undefined, name: string) {
  if (value === undefined) return DEFAULT_DIMENSION
  const integer = boundedInteger(value, name, MIN_DIMENSION, MAX_DIMENSION)
  return Math.round(integer / DIMENSION_GRID) * DIMENSION_GRID
}

function boundedInteger(
  value: HarnessJsonValue,
  name: string,
  minimum: number,
  maximum: number
) {
  if (
    typeof value !== 'number' ||
    !Number.isInteger(value) ||
    value < minimum ||
    value > maximum
  ) {
    throw new Error(
      `${name} must be an integer from ${minimum} to ${maximum}`
    )
  }
  return value
}

function validProgress(progress: HarnessToolProgress) {
  return (
    Number.isInteger(progress.step) &&
    Number.isInteger(progress.totalSteps) &&
    Number.isFinite(progress.elapsedMs) &&
    progress.step >= 1 &&
    progress.totalSteps >= progress.step &&
    progress.elapsedMs >= 0
  )
}

async function prepareAttachmentNamespace(
  configuredBase: string
): Promise<AttachmentNamespace> {
  if (!path.isAbsolute(configuredBase)) {
    throw new Error('attachment base must be an absolute path')
  }
  const base = path.resolve(configuredBase)
  const baseComponents = pathComponents(base)
  await ensureDirectoryChain(baseComponents)
  await verifyDirectoryChain(baseComponents)

  const ownershipToken = opaqueId()
  const directory = path.join(
    base,
    `.qvac-attachments-${ownershipToken}`
  )
  const marker = path.join(directory, OWNERSHIP_MARKER)
  assertInsideRoot(base, directory)
  let created = false
  try {
    await fs.mkdir(directory, { mode: 0o700 })
    created = true
    await verifyDirectory(directory)
    await fs.chmod(directory, 0o700)
    await fs.writeFile(marker, ownershipToken, {
      flag: 'wx',
      mode: 0o600
    })
    await fs.chmod(marker, 0o600)
  } catch (error) {
    if (created) {
      await fs.rm(directory, { recursive: true, force: true }).catch(() => {})
    }
    throw error
  }
  const attachmentNamespace = {
    baseComponents,
    directory,
    marker,
    ownershipToken
  }
  await verifyOwnedNamespace(attachmentNamespace)
  return attachmentNamespace
}

function pathComponents(target: string) {
  const components: string[] = []
  let current = target
  while (true) {
    components.unshift(current)
    const parent = path.dirname(current)
    if (parent === current) return components
    current = parent
  }
}

async function ensureDirectoryChain(components: readonly string[]) {
  for (const component of components) {
    try {
      await verifyDirectory(component)
    } catch (error) {
      if (errorCode(error) !== 'ENOENT') throw error
      try {
        await fs.mkdir(component, { mode: 0o700 })
      } catch (mkdirError) {
        if (errorCode(mkdirError) !== 'EEXIST') throw mkdirError
      }
      await verifyDirectory(component)
    }
  }
}

async function verifyDirectoryChain(components: readonly string[]) {
  for (const component of components) await verifyDirectory(component)
}

async function verifyDirectory(directory: string) {
  const entry = await fs.lstat(directory)
  if (entry.isSymbolicLink()) {
    throw new Error(`attachment base contains a symlink: ${directory}`)
  }
  if (!entry.isDirectory()) {
    throw new Error(`attachment base component is not a directory: ${directory}`)
  }
}

async function verifyOwnedNamespace(
  attachmentNamespace: AttachmentNamespace
) {
  await verifyDirectoryChain(attachmentNamespace.baseComponents)
  await verifyDirectory(attachmentNamespace.directory)
  const marker = await fs.lstat(attachmentNamespace.marker)
  if (marker.isSymbolicLink() || !marker.isFile()) {
    throw new Error('attachment ownership marker is invalid')
  }
  const ownershipToken = await fs.readFile(
    attachmentNamespace.marker,
    'utf8'
  )
  if (ownershipToken !== attachmentNamespace.ownershipToken) {
    throw new Error('attachment ownership marker does not match this runtime')
  }
}

async function persistPng(
  attachmentNamespace: AttachmentNamespace,
  fileSystem: ImageAttachmentFileSystem,
  image: Uint8Array,
  width: number,
  height: number
) {
  validatePng(image, width, height)
  await verifyOwnedNamespace(attachmentNamespace)
  const attachmentRoot = attachmentNamespace.directory
  const runId = opaqueId()
  const attachmentId = opaqueId()
  const runDirectory = path.join(attachmentRoot, runId)
  assertInsideRoot(attachmentRoot, runDirectory)
  await fs.mkdir(runDirectory, { mode: 0o700 })
  const runEntry = await fs.lstat(runDirectory)
  if (runEntry.isSymbolicLink() || !runEntry.isDirectory()) {
    await fs.rm(runDirectory, { recursive: true, force: true }).catch(() => {})
    throw new Error('attachment run path must be a real directory')
  }
  const filePath = path.join(runDirectory, `${attachmentId}.png`)
  const temporaryPath = path.join(
    runDirectory,
    `.${attachmentId}.${opaqueId()}.partial`
  )
  assertInsideRoot(attachmentRoot, filePath)
  let handle: ImageAttachmentFileHandle | undefined
  try {
    handle = await fileSystem.open(temporaryPath, 'wx', 0o600)
    await writeAll(handle, image)
    await handle.sync()
    await handle.close()
    handle = undefined
    await fileSystem.rename(temporaryPath, filePath)
    await fileSystem.chmod(filePath, 0o600)
    return {
      id: attachmentId,
      path: filePath,
      mimeType: 'image/png',
      byteLength: image.byteLength,
      width,
      height
    }
  } catch (error) {
    await handle?.close().catch(() => {})
    await fs.rm(temporaryPath, { force: true }).catch(() => {})
    await fs.rm(runDirectory, { recursive: true, force: true }).catch(() => {})
    throw error
  }
}

async function writeAll(
  handle: ImageAttachmentFileHandle,
  image: Uint8Array
) {
  let offset = 0
  while (offset < image.byteLength) {
    const { bytesWritten } = await handle.write(
      image,
      offset,
      image.byteLength - offset,
      offset
    )
    if (bytesWritten <= 0) {
      throw new Error('failed to make progress writing PNG attachment')
    }
    offset += bytesWritten
  }
}

function validatePng(image: Uint8Array, expectedWidth: number, expectedHeight: number) {
  if (image.byteLength > MAX_IMAGE_BYTES) {
    throw new Error('generated PNG exceeds the 64 MiB attachment limit')
  }
  if (
    image.byteLength < 24 ||
    PNG_SIGNATURE.some((byte, index) => image[index] !== byte)
  ) {
    throw new Error('generated image has an invalid PNG signature')
  }
  const view = new DataView(image.buffer, image.byteOffset, image.byteLength)
  const ihdrLength = view.getUint32(8)
  const ihdrType = String.fromCharCode(...image.slice(12, 16))
  if (ihdrLength !== 13 || ihdrType !== 'IHDR') {
    throw new Error('generated image has an invalid PNG IHDR')
  }
  const width = view.getUint32(16)
  const height = view.getUint32(20)
  if (width !== expectedWidth || height !== expectedHeight) {
    throw new Error(
      `generated PNG IHDR dimensions ${width}x${height} do not match requested ${expectedWidth}x${expectedHeight}`
    )
  }
}

function assertInsideRoot(root: string, candidate: string) {
  const relative = path.relative(root, candidate)
  if (
    relative === '' ||
    relative === '..' ||
    relative.startsWith(`..${path.sep}`) ||
    path.isAbsolute(relative)
  ) {
    throw new Error('attachment path escapes the configured root')
  }
}

function opaqueId() {
  return crypto.randomBytes(16).toString('hex')
}

function invocationKey(
  input: Pick<
    HarnessToolInvocation,
    'agentId' | 'runId' | 'operationId'
  >
) {
  return `${input.agentId}\0${input.runId}\0${input.operationId}`
}

function errorCode(error: unknown) {
  return typeof error === 'object' && error !== null
    ? Reflect.get(error, 'code')
    : undefined
}

const DEFAULT_ATTACHMENT_FILE_SYSTEM: ImageAttachmentFileSystem = {
  async open(filePath, flags, mode) {
    return fs.open(filePath, flags, mode)
  },
  async chmod(filePath, mode) {
    await fs.chmod(filePath, mode)
  },
  async rename(source, destination) {
    await fs.rename(source, destination)
  }
}

const GENERATE_IMAGE_TOOL: HarnessTool = {
  schema: {
    type: 'function',
    name: 'generate_image',
    description:
      'Generate one local PNG attachment from a text prompt using the shared SDK runtime.',
    parameters: {
      type: 'object',
      properties: {
        prompt: {
          type: 'string',
          description: 'Text description of the image to generate.'
        },
        negative_prompt: {
          type: 'string',
          description: 'Optional text describing what the image should avoid.'
        },
        width: {
          type: 'integer',
          description: 'Width from 64 to 1024 pixels, snapped to a 64-pixel grid.'
        },
        height: {
          type: 'integer',
          description: 'Height from 64 to 1024 pixels, snapped to a 64-pixel grid.'
        },
        steps: {
          type: 'integer',
          description: 'Sampling steps from 1 to 100.'
        },
        seed: {
          type: 'integer',
          description: 'Seed from -1 through 4294967295.'
        }
      },
      required: ['prompt']
    }
  }
}
