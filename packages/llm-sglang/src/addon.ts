export interface AddonLogger {
  error?: (...args: unknown[]) => void
  info?: (...args: unknown[]) => void
  warn?: (...args: unknown[]) => void
}

export interface LlmSglangBinding {
  createInstance(
    owner: LlmSglangInterface,
    configurationParams: { baseUrl: string },
    outputCallback: LlmSglangOutputCallback
  ): object
  activate(handle: unknown): void
  runJob(handle: unknown, input: SglangJob): Promise<boolean> | boolean
  cancel(handle: unknown): Promise<void> | void
  destroyInstance(handle: unknown): void
}

export interface SglangJob {
  messages: unknown[]
  generationParams?: Record<string, unknown>
}

export type LlmSglangOutputCallback = (
  addon: LlmSglangInterface,
  event: unknown,
  data: unknown,
  error: unknown
) => void

export type MappedAddonEvent = {
  type: 'Output' | 'Error' | 'JobEnded'
  data: unknown
  error: unknown
}

/**
 * Normalize a native event into Output, Error, or JobEnded. String payloads
 * are token deltas. A plain object is the terminal runtime-stats snapshot.
 */
export function mapAddonEvent(
  rawEvent: unknown,
  rawData: unknown,
  rawError: unknown
): MappedAddonEvent | null {
  if (typeof rawEvent === 'string' && rawEvent.includes('LogMsg')) {
    return null
  }
  if (typeof rawEvent === 'string' && rawEvent.includes('Error')) {
    return { type: 'Error', data: rawData, error: rawError }
  }
  if (typeof rawData === 'string') {
    return { type: 'Output', data: rawData, error: null }
  }
  if (rawData && typeof rawData === 'object') {
    return { type: 'JobEnded', data: rawData, error: null }
  }
  if (typeof rawEvent === 'string' && rawEvent.includes('JobEnded')) {
    return { type: 'JobEnded', data: rawData, error: null }
  }
  return null
}

export class LlmSglangInterface {
  private readonly binding: LlmSglangBinding
  private handle: object | null

  constructor(
    binding: LlmSglangBinding,
    configurationParams: { baseUrl: string },
    outputCallback: LlmSglangOutputCallback
  ) {
    this.binding = binding
    this.handle = this.binding.createInstance(this, configurationParams, outputCallback)
  }

  activate(): Promise<void> {
    if (!this.handle) {
      throw new Error('SGLang addon is not initialized')
    }
    this.binding.activate(this.handle)
    return Promise.resolve()
  }

  async runJob(input: SglangJob): Promise<boolean> {
    if (!this.handle) {
      throw new Error('SGLang addon is not initialized')
    }
    return this.binding.runJob(this.handle, input)
  }

  async cancel(): Promise<void> {
    if (!this.handle) return
    await this.binding.cancel(this.handle)
  }

  unload(): Promise<void> {
    if (this.handle === null) return Promise.resolve()
    try {
      this.binding.destroyInstance(this.handle)
    } finally {
      this.handle = null
    }
    return Promise.resolve()
  }
}
