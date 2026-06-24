export type EndpointCategory =
  | 'chat'
  | 'embedding'
  | 'transcription'
  | 'audio-translation'
  | 'translation'
  | 'speech'
  | 'ocr'
  | 'image'

// Generic so callers can preserve per-constant endpoint literals:
// `ModelConstant<'chat'>`, `ModelConstant<'embedding'>`, etc. The codegen
// step emits each constant with the narrowed generic so consumers get
// precise types (mirrors @qvac/sdk's `ModelConstant<TEngine>` pattern).
export interface ModelConstant<TEndpoint extends EndpointCategory = EndpointCategory> {
  readonly name: string
  readonly src: string
  readonly registryPath: string
  readonly registrySource: string
  readonly blobCoreKey: string
  readonly blobBlockOffset: number
  readonly blobBlockLength: number
  readonly blobByteOffset: number
  readonly modelId: string
  readonly expectedSize: number
  readonly sha256Checksum: string
  readonly addon: string
  readonly engine: string
  readonly quantization?: string
  readonly params?: string
  readonly endpointCategory: TEndpoint
}
