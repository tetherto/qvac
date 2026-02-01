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

export class QVACRegistryClient {
  constructor (opts?: QVACRegistryClientOptions)

  ready (): Promise<void>
  close (): Promise<void>

  getModel (path: string, source: string): Promise<QVACModelEntry | null>
  downloadModel (path: string, source: string, options?: QVACDownloadOptions): Promise<QVACDownloadResult>
  findModels (query?: QVACModelQuery): Promise<QVACModelEntry[]>
  findModelsByEngine (query?: QVACModelQuery): Promise<QVACModelEntry[]>
  findModelsByName (query?: QVACModelQuery): Promise<QVACModelEntry[]>
  findModelsByQuantization (query?: QVACModelQuery): Promise<QVACModelEntry[]>
}
