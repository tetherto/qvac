import ReadyResource = require('ready-resource')

export interface LifecycleLogOptions {
  log?: (msg: string) => Promise<void> | void
}

export interface QVACBlobBinding {
  coreKey: Buffer | string
  blockOffset: number
  blockLength: number
  byteOffset: number
  byteLength: number
  sha256: string
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
  /**
   * Raw GGUF key-value metadata extracted at ingest, serialised as a JSON string.
   *
   * - Only present for GGUF artifacts; absent for other formats and when
   *   extraction failed (e.g. some GGUF v3 files).
   * - Tensor infos are discarded and every `tokenizer.*` key is stripped.
   * - For sharded models only the first shard (`-00001-of-`) is described.
   * - Numeric values that exceeded the safe integer range are stringified.
   */
  ggufMetadata?: string
  /**
   * Points at a weightless description of this artifact: the tensor list an
   * engine's dry-run fitter reads, with none of the weights.
   *
   * - For a GGUF it is a short GGUF holding the tensor list and the settings
   *   without the tokenizer tables; for a safetensors it is the JSON header.
   * - Present for GGUF and safetensors artifacts, every shard of a split model
   *   included; absent for other formats and when it could not be built.
   * - Written to the writer's active blob core, which is not always the one
   *   holding the weights; `downloadBlob` takes the binding directly.
   * - `sha256` covers the description, not the artifact it came from.
   */
  fitBlobBinding?: QVACBlobBinding
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
  maxRetries?: number
  outputFile?: string
  onProgress?: (progress: {
    downloaded: number
    total: number
    cachedBlocks: number
    totalBlocks: number
  }) => void
  signal?: AbortSignal
}

export interface QVACBlobDownloadOptions {
  timeout?: number
  maxRetries?: number
  outputFile?: string
  onProgress?: (progress: {
    downloaded: number
    total: number
    cachedBlocks: number
    totalBlocks: number
  }) => void
  signal?: AbortSignal
}

export interface QVACBlobDownloadResult {
  artifact: QVACDownloadedArtifact & { totalSize: number }
}

export interface QVACRegistryClientOptions {
  storage?: string
  registryCoreKey?: string
  logger?: any
  corestoreOpts?: { wait?: boolean }
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

export interface LifecycleSwarmHandle {
  readonly suspended: boolean
  suspend(opts?: LifecycleLogOptions): Promise<void>
  resume(opts?: LifecycleLogOptions): Promise<void>
}

export interface LifecycleStoreHandle {
  suspend(opts?: LifecycleLogOptions): Promise<void>
  resume(): Promise<void>
}

export class QVACRegistryClient extends ReadyResource {
  constructor(opts?: QVACRegistryClientOptions)

  /** Valid only while the client remains open. Cached handles become stale after close(). */
  readonly corestore: LifecycleStoreHandle | null
  /** Valid only while the client remains open. Cached handles become stale after close(). */
  readonly hyperswarm: LifecycleSwarmHandle | null

  ready(): Promise<void>
  close(): Promise<void>
  suspend(opts?: LifecycleLogOptions): Promise<void>
  resume(opts?: LifecycleLogOptions): Promise<void>

  getModel(path: string, source: string): Promise<QVACModelEntry | null>
  downloadModel(
    path: string,
    source: string,
    options?: QVACDownloadOptions
  ): Promise<QVACDownloadResult>
  downloadBlob(
    blobBinding: QVACBlobBinding,
    options?: QVACBlobDownloadOptions
  ): Promise<QVACBlobDownloadResult>

  findBy(params?: FindByParams): Promise<QVACModelEntry[]>
  findModels(query?: QVACModelQuery): Promise<QVACModelEntry[]>
  findModelsByEngine(query?: QVACModelQuery): Promise<QVACModelEntry[]>
  findModelsByName(query?: QVACModelQuery): Promise<QVACModelEntry[]>
  findModelsByQuantization(query?: QVACModelQuery): Promise<QVACModelEntry[]>
}
