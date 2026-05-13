const MIN_SDK_VERSION = '0.10.0'
const SDK_SPECIFIER = '@qvac/sdk'
const SDK_PACKAGE_SPECIFIER = '@qvac/sdk/package'

export interface SDKGenerationParams {
  temp?: number
  top_p?: number
  top_k?: number
  predict?: number
  seed?: number
  frequency_penalty?: number
  presence_penalty?: number
  repeat_penalty?: number
  reasoning_budget?: boolean
}

export type SDKResponseFormat =
  | { type: 'text' }
  | { type: 'json_object' }
  | {
      type: 'json_schema'
      json_schema: {
        name: string
        description?: string
        schema: Record<string, unknown>
        strict?: boolean
      }
    }

export interface RagWorkspaceInfo {
  name: string
  open: boolean
}

export interface RagSearchResult {
  id: string
  content: string
  score: number
}

interface SDKModule {
  loadModel: (opts: { modelSrc: string; modelType: string; modelConfig: Record<string, unknown> }) => Promise<string>
  unloadModel: (opts: { modelId: string }) => Promise<void>
  completion: (opts: {
    modelId: string
    history: Array<{ role: string; content: string }>
    stream: boolean
    tools?: SDKTool[]
    generationParams?: SDKGenerationParams
    responseFormat?: SDKResponseFormat
  }) => Promise<CompletionResult>
  embed: (opts: { modelId: string; text: string | string[] }) => Promise<{ embedding: number[] | number[][]; stats?: Record<string, unknown> }>
  transcribe: (opts: { modelId: string; audioChunk: string | Buffer; prompt?: string }) => Promise<string>
  diffusion: (opts: SDKDiffusionParams) => SDKDiffusionResult
  ragListWorkspaces: () => Promise<RagWorkspaceInfo[]>
  ragSearch: (opts: {
    modelId: string
    query: string
    topK?: number
    n?: number
    workspace?: string
  }) => Promise<RagSearchResult[]>
  ragDeleteWorkspace: (opts: { workspace: string }) => Promise<void>
  ragCloseWorkspace: (opts: { workspace?: string; deleteOnClose?: boolean }) => Promise<void>
  ragIngest: (opts: {
    modelId: string
    documents: string | string[]
    workspace?: string
    chunk?: boolean
  }) => Promise<{ processed: unknown[]; droppedIndices: number[] }>
  close: () => Promise<void>
  [key: string]: unknown
}

export interface SDKDiffusionParams {
  modelId: string
  prompt: string
  negative_prompt?: string
  width?: number
  height?: number
  steps?: number
  seed?: number
  batch_count?: number
  cfg_scale?: number
  guidance?: number
  sampling_method?: string
  scheduler?: string
  /** Base image for img2img / image edits (SDK `diffusion()`). */
  init_image?: Uint8Array
  /** SD/SDXL denoising strength in [0, 1]; ignored by FLUX.2. */
  strength?: number
}

export interface SDKDiffusionStats {
  width?: number
  height?: number
  seed?: number
  totalSteps?: number
  totalImages?: number
  generationMs?: number
  totalGenerationMs?: number
  totalWallMs?: number
}

export interface SDKDiffusionProgressTick {
  step: number
  totalSteps: number
  elapsedMs: number
}

export interface SDKDiffusionResult {
  progressStream: AsyncIterable<SDKDiffusionProgressTick>
  outputs: Promise<Uint8Array[]>
  stats: Promise<SDKDiffusionStats | undefined>
}

export interface SDKTool {
  type: string
  name: string
  description: string
  parameters: Record<string, unknown>
}

export interface SDKToolCall {
  id: string
  name: string
  arguments: string | Record<string, unknown>
}

/** Subset of SDK completion stats surfaced to OpenAI-compatible usage fields. */
export interface CompletionRunStats {
  generatedTokens?: number
  cacheTokens?: number
  tokensPerSecond?: number
  timeToFirstToken?: number
  backendDevice?: 'cpu' | 'gpu'
}

export interface CompletionResult {
  text: Promise<string>
  stats: Promise<CompletionRunStats | undefined>
  toolCalls: Promise<SDKToolCall[] | null>
  tokenStream: AsyncIterable<string>
  toolCallStream: AsyncIterable<SDKToolEvent>
}

export interface SDKToolCallEvent {
  type: 'toolCall'
  call: SDKToolCall
}

export interface SDKToolCallErrorEvent {
  type: 'toolCallError'
  error: { code: string; message: string; raw?: string }
}

export type SDKToolEvent = SDKToolCallEvent | SDKToolCallErrorEvent

let sdk: SDKModule | null = null

export async function getSDK (): Promise<SDKModule> {
  if (sdk) return sdk

  let loaded: SDKModule
  try {
    loaded = await import(SDK_SPECIFIER) as unknown as SDKModule
  } catch {
    throw new Error(
      '@qvac/sdk is required for "qvac serve openai". Install it: npm install @qvac/sdk'
    )
  }

  const sdkVersion = await resolveSDKVersion()
  if (sdkVersion && !satisfiesMinVersion(sdkVersion, MIN_SDK_VERSION)) {
    throw new Error(
      `@qvac/sdk ${sdkVersion} is too old for this version of @qvac/cli. ` +
      `Minimum required: ${MIN_SDK_VERSION}. Run: npm install @qvac/sdk@latest`
    )
  }

  sdk = loaded
  return sdk
}

async function resolveSDKVersion (): Promise<string | null> {
  try {
    const pkg = await import(SDK_PACKAGE_SPECIFIER) as { version?: string }
    return pkg.version ?? null
  } catch {
    return null
  }
}

function satisfiesMinVersion (current: string, minimum: string): boolean {
  const parse = (v: string): number[] => v.split('.').map(Number)
  const cur = parse(current)
  const min = parse(minimum)

  for (let i = 0; i < 3; i++) {
    const c = cur[i] ?? 0
    const m = min[i] ?? 0
    if (c > m) return true
    if (c < m) return false
  }
  return true
}

export async function sdkLoadModel (opts: {
  src: string
  type: string
  config: Record<string, unknown>
}): Promise<string> {
  const { loadModel } = await getSDK()
  const modelId = await loadModel({
    modelSrc: opts.src,
    modelType: opts.type,
    modelConfig: opts.config
  })
  return modelId
}

export async function sdkUnloadModel (modelId: string): Promise<void> {
  const { unloadModel } = await getSDK()
  await unloadModel({ modelId })
}

export async function sdkCompletion (opts: {
  modelId: string
  history: Array<{ role: string; content: string }>
  stream: boolean
  tools?: SDKTool[] | undefined
  generationParams?: SDKGenerationParams | undefined
  responseFormat?: SDKResponseFormat | undefined
}): Promise<CompletionResult> {
  const { completion } = await getSDK()
  const params: Record<string, unknown> = {
    modelId: opts.modelId,
    history: opts.history,
    stream: opts.stream
  }
  if (opts.tools) {
    params['tools'] = opts.tools
  }
  if (opts.generationParams) {
    const { reasoning_budget, ...rest } = opts.generationParams
    const sdkGenParams: Record<string, unknown> = { ...rest }
    if (reasoning_budget !== undefined) {
      sdkGenParams['reasoning_budget'] = reasoning_budget ? -1 : 0
    }
    params['generationParams'] = sdkGenParams
  }
  if (opts.responseFormat) {
    params['responseFormat'] = opts.responseFormat
  }
  return completion(params as Parameters<SDKModule['completion']>[0])
}

export async function sdkEmbed (opts: {
  modelId: string
  text: string | string[]
}): Promise<number[] | number[][]> {
  const { embed } = await getSDK()
  const { embedding } = await embed({ modelId: opts.modelId, text: opts.text })
  return embedding
}

export async function sdkTranscribe (opts: {
  modelId: string
  audioChunk: Buffer
  fileName: string
  prompt?: string | undefined
}): Promise<string> {
  const fs = await import('node:fs')
  const os = await import('node:os')
  const path = await import('node:path')

  const ext = path.extname(opts.fileName) || '.wav'
  const id = `${Date.now()}-${Math.random().toString(36).slice(2, 10)}`
  const tmpFile = path.join(os.tmpdir(), `qvac-audio-${id}${ext}`)
  fs.writeFileSync(tmpFile, opts.audioChunk)

  try {
    const { transcribe } = await getSDK()
    return await transcribe({
      modelId: opts.modelId,
      audioChunk: tmpFile,
      ...(opts.prompt && { prompt: opts.prompt })
    })
  } finally {
    try { fs.unlinkSync(tmpFile) } catch {}
  }
}

export interface SDKDiffusionRunResult {
  buffers: Uint8Array[]
  stats: SDKDiffusionStats | undefined
}

export async function sdkDiffusion (opts: {
  params: SDKDiffusionParams
  onProgress?: (tick: SDKDiffusionProgressTick) => void
}): Promise<SDKDiffusionRunResult> {
  const { diffusion } = await getSDK()
  const result = diffusion(opts.params)

  const drainProgress = async (): Promise<void> => {
    try {
      for await (const tick of result.progressStream) {
        if (opts.onProgress) opts.onProgress(tick)
      }
    } catch {
      // Progress drain errors are reported via outputs/stats below.
    }
  }

  const [buffers, stats] = await Promise.all([
    result.outputs,
    result.stats,
    drainProgress()
  ])

  return { buffers, stats }
}

export async function sdkRagListWorkspaces (): Promise<RagWorkspaceInfo[]> {
  const { ragListWorkspaces } = await getSDK()
  return ragListWorkspaces()
}

export async function sdkRagSearch (opts: {
  modelId: string
  query: string
  topK?: number | undefined
  n?: number | undefined
  workspace?: string | undefined
}): Promise<RagSearchResult[]> {
  const { ragSearch } = await getSDK()
  const params: Parameters<SDKModule['ragSearch']>[0] = {
    modelId: opts.modelId,
    query: opts.query
  }
  if (opts.topK !== undefined) params.topK = opts.topK
  if (opts.n !== undefined) params.n = opts.n
  if (opts.workspace !== undefined) params.workspace = opts.workspace
  return ragSearch(params)
}

export async function sdkRagDeleteWorkspace (opts: { workspace: string }): Promise<void> {
  const { ragDeleteWorkspace } = await getSDK()
  await ragDeleteWorkspace({ workspace: opts.workspace })
}

export async function sdkRagCloseWorkspace (opts: {
  workspace?: string | undefined
  deleteOnClose?: boolean | undefined
}): Promise<void> {
  const { ragCloseWorkspace } = await getSDK()
  const params: Parameters<SDKModule['ragCloseWorkspace']>[0] = {}
  if (opts.workspace !== undefined) params.workspace = opts.workspace
  if (opts.deleteOnClose !== undefined) params.deleteOnClose = opts.deleteOnClose
  await ragCloseWorkspace(params)
}

export async function sdkRagIngest (opts: {
  modelId: string
  documents: string | string[]
  workspace?: string | undefined
  chunk?: boolean | undefined
}): Promise<{ processed: unknown[]; droppedIndices: number[] }> {
  const { ragIngest } = await getSDK()
  const params: Parameters<SDKModule['ragIngest']>[0] = {
    modelId: opts.modelId,
    documents: opts.documents,
    chunk: opts.chunk ?? true
  }
  if (opts.workspace !== undefined) params.workspace = opts.workspace
  return ragIngest(params)
}

export async function sdkClose (): Promise<void> {
  const { close } = await getSDK()
  await close()
}
