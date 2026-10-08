import { decide, type DecideParams, type LayaResult } from '@qvac/sdk'
import type { QvacContext } from '@/serve/core/context'

export type DecideFn = (
  params: Extract<DecideParams, { state: unknown }>
) => Promise<LayaResult> & { requestId: string }

export interface SystemOneState {
  decide: DecideFn
}

export interface SystemOneOptions {
  /** Overrides SDK inference for HTTP contract tests. */
  decideOverride?: DecideFn
}

declare module '@/serve/core/context' {
  interface ServeExtensionState {
    systemone: SystemOneState
  }
}

export function createSystemOneState(options: SystemOneOptions | undefined): SystemOneState {
  return { decide: options?.decideOverride ?? decide }
}

export function systemOneState(ctx: QvacContext): SystemOneState {
  const state = ctx.extensions.systemone
  if (state === undefined) throw new Error('The systemone extension is not mounted.')
  return state
}
