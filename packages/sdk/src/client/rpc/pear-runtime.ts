/** The part of a `pear-runtime` instance the worker harness uses. */
export interface PearRuntime {
  run(path: string, args?: string[], opts?: object): unknown
}

let pearRuntime: PearRuntime | null = null

/**
 * Starts the SDK worker through `pear` from then on, from the `pear-runtime`
 * bundle that `qvac bundle sdk --target pear-runtime` writes. Call it before
 * the first SDK call.
 */
export function usePearRuntime(pear: PearRuntime): void {
  pearRuntime = pear
}

export function getPearRuntime(): PearRuntime | null {
  return pearRuntime
}
