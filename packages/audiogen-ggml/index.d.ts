export const ENGINE_ACESTEP: 'acestep'

/** The interchangeable DiT stage; the other three stages are fixed. */
export type DitVariant = 'turbo-q4' | 'turbo-q8' | 'sft'

export interface AudioGenOptions {
  modelDir?: string
  textEncModel?: string
  lmModel?: string
  ditModel?: string
  /** Selects the DiT GGUF from `modelDir` when `ditModel` is not given. */
  ditVariant?: DitVariant
  vaeModel?: string
  inferenceSteps?: number
  shift?: number
  useGpu?: boolean
  threads?: number
}

export interface ModelManifest {
  textEnc: string
  lm: string
  dit: string
  vae: string
}

export interface ModelSources {
  textEncModelSrc: string
  lmModelSrc: string
  ditModelSrc: string
  vaeModelSrc: string
}

/** Source name for the model registry (the `source` arg of downloadModel/getModel). */
export const REGISTRY_SOURCE: string
/** Registry build folder holding the published ACE-Step GGUFs. */
export const REGISTRY_PREFIX: string
/** DiT variant -> GGUF filename. */
export const DIT_VARIANTS: Record<DitVariant, string>
export const DEFAULT_DIT_VARIANT: DitVariant
export function ditVariants (): DitVariant[]
export function ditFilename (variant?: DitVariant): string
export function modelFilenames (variant?: DitVariant): ModelManifest
export function modelManifest (variant?: DitVariant): ModelManifest
export function modelSources (variant?: DitVariant): ModelSources
export function allRegistryPaths (): string[]

export interface GenerateOptions {
  lyrics?: string
  seed?: number
  vocalLanguage?: string
}

export interface GenerateResult {
  outputArray: Int16Array
  sampleRate: number
  channels: number
  metadata: {
    caption?: string
    lyrics?: string
    keyscale?: string
    bpm?: number
    timesignature?: number
    vocalLanguage?: string
    seed?: number
    codes?: number
  }
}

export type OutputCallback = (event: unknown) => void

export class AudioGen {
  constructor (options?: AudioGenOptions, outputCb?: OutputCallback | null)
  activate (): Promise<void>
  generate (caption: string, opts?: GenerateOptions): Promise<GenerateResult>
  cancel (): Promise<void>
  destroy (): Promise<void>
  unload (): Promise<void>
}
