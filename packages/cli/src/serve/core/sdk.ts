const MIN_SDK_VERSION = '0.7.0'
const SDK_SPECIFIER = '@qvac/sdk'
const SDK_PACKAGE_SPECIFIER = '@qvac/sdk/package'

interface SDKModule {
  loadModel: (opts: { modelSrc: string; modelType: string; modelConfig: Record<string, unknown> }) => Promise<string>
  unloadModel: (opts: { modelId: string }) => Promise<void>
  completion: (opts: {
    modelId: string
    history: Array<{ role: string; content: string }>
    stream: boolean
    tools?: SDKTool[]
  }) => Promise<CompletionResult>
  embed: (opts: { modelId: string; text: string | string[] }) => Promise<number[] | number[][]>
  close: () => Promise<void>
  [key: string]: unknown
}

export interface SDKTool {
  type: string
  name: string
  description: string
  parameters: Record<string, unknown>
}

export interface CompletionResult {
  text: Promise<string>
  stats: Promise<Record<string, unknown>>
  toolCalls: Promise<SDKToolCall[] | null>
  tokenStream: AsyncIterable<string>
}

export interface SDKToolCall {
  id: string
  name: string
  arguments: string | Record<string, unknown>
}

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
  return completion(params as Parameters<SDKModule['completion']>[0])
}

export async function sdkEmbed (opts: {
  modelId: string
  text: string | string[]
}): Promise<number[] | number[][]> {
  const { embed } = await getSDK()
  return embed({ modelId: opts.modelId, text: opts.text })
}

export async function sdkClose (): Promise<void> {
  const { close } = await getSDK()
  await close()
}
