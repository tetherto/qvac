import { findCatalogEntry } from '@qvac/ai-sdk-provider/models'

import { mergeOptions, optionsFromEnv } from './options.js'

export interface ManagedServeHostConfig {
  readonly modelId: string
  readonly modelName: string
  readonly ctxSize: number
  readonly reasoningBudget: number
  readonly tools: boolean
  readonly openAICompatTransforms: boolean
  readonly readyTimeoutMs: number
  readonly upstreamTimeoutMs: number
  readonly debug: boolean
  readonly logFile: string | undefined
}

function numberFromEnv(value: string | undefined, fallback: number): number {
  if (value === undefined) return fallback
  const n = Number(value)
  return Number.isFinite(n) ? n : fallback
}

export function resolveManagedServeHostConfig(env: NodeJS.ProcessEnv): ManagedServeHostConfig {
  const options = mergeOptions(optionsFromEnv(env))
  const catalogEntry = findCatalogEntry(options.model)
  return {
    modelId: catalogEntry?.id ?? options.model,
    modelName: catalogEntry?.name ?? options.model,
    ctxSize: options.ctxSize,
    reasoningBudget: options.reasoningBudget,
    tools: options.tools,
    openAICompatTransforms: options.shim,
    readyTimeoutMs: options.readyTimeoutMs,
    upstreamTimeoutMs: numberFromEnv(env['QVAC_UPSTREAM_TIMEOUT_MS'], 300_000),
    debug: options.debug,
    logFile: env['QVAC_HOST_LOG']
  }
}
