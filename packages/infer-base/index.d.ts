import QvacResponse from './src/QvacResponse'

/**
 * Creates a serialized execution queue. Calls to the returned function
 * run one at a time, in order, even when fired concurrently.
 */
export function exclusiveRunQueue(): (fn: () => Promise<any>) => Promise<any>

/**
 * Returns the graphics API identifier for the current platform.
 * Falls back to 'vulkan' on unknown platforms.
 */
export function getApiDefinition(): string

export interface JobHandler {
  /** Creates a new QvacResponse and stores it as active. Fails any stale active response. */
  start(): QvacResponse
  /** Registers a pre-built response (e.g. a custom subclass) as active. Fails any stale active response. */
  startWith(response: QvacResponse): QvacResponse
  /** Routes output data to the active response. No-op if idle. */
  output(data: any): void
  /** Ends the active response. Optionally forwards stats before ending. */
  end(stats?: any, result?: any): void
  /** Fails the active response with an error. */
  fail(error: Error | string): void
  /** The current active QvacResponse, or null if idle. */
  readonly active: QvacResponse | null
}

/**
 * Creates a single-job handler that manages the lifecycle of a QvacResponse.
 */
export function createJobHandler(opts: { cancel: () => void | Promise<void> }): JobHandler

export { QvacResponse }
