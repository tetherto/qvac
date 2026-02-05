export interface QVACBlobBinding {
  coreKey: Buffer
  blockOffset: number
  blockLength: number
  byteOffset: number
  byteLength: number
}

export interface QVACModelEntry {
  path: string
  source: string
  engine: string
  license: string
  name: string
  sizeBytes: number
  sha256: string
  quantization?: string
  params?: string
  description?: string
  notes?: string
  tags?: string[]
  blobBinding: QVACBlobBinding
}

export interface QVACDownloadedArtifactStream {
  stream: NodeJS.ReadableStream
}

export interface QVACDownloadedArtifactPath {
  path: string
}

export type QVACDownloadedArtifact = QVACDownloadedArtifactStream | QVACDownloadedArtifactPath

export interface QVACDownloadResult {
  model: QVACModelEntry
  artifact: QVACDownloadedArtifact
}

export interface QVACDownloadOptions {
  timeout?: number
  peerTimeout?: number
  outputFile?: string
}

export interface QVACRegistryClientOptions {
  storage?: string
  registryCoreKey?: string
  logger?: any
}

export interface QVACModelQuery {
  gte?: Record<string, any>
  lte?: Record<string, any>
  gt?: Record<string, any>
  lt?: Record<string, any>
}

export interface FindByParams {
  /** Filter by name (partial match, case-insensitive) */
  name?: string
  /** Filter by engine (exact match) */
  engine?: string
  /** Filter by quantization (partial match, case-insensitive) */
  quantization?: string
  /** Include deprecated models (default: false) */
  includeDeprecated?: boolean
}

export class QVACRegistryClient {
  constructor (opts?: QVACRegistryClientOptions)

  ready (): Promise<void>
  close (): Promise<void>

  getModel (path: string, source: string): Promise<QVACModelEntry | null>
  downloadModel (path: string, source: string, options?: QVACDownloadOptions): Promise<QVACDownloadResult>

  /** Simplified API - find models with optional filters */
  findBy (params?: FindByParams): Promise<QVACModelEntry[]>

  /** Legacy API - find models by path using HyperDB range query */
  findModels (query?: QVACModelQuery): Promise<QVACModelEntry[]>
  /** Legacy API - find models by engine using HyperDB range query */
  findModelsByEngine (query?: QVACModelQuery): Promise<QVACModelEntry[]>
  /** Legacy API - find models by name using HyperDB range query */
  findModelsByName (query?: QVACModelQuery): Promise<QVACModelEntry[]>
  /** Legacy API - find models by quantization using HyperDB range query */
  findModelsByQuantization (query?: QVACModelQuery): Promise<QVACModelEntry[]>
}
