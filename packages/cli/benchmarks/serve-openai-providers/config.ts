import { readFileSync } from 'node:fs'
import { isAbsolute } from 'node:path'
import { load as loadYaml } from 'js-yaml'
import type { BenchmarkConfig } from './types.ts'

export const PLACEHOLDER_PREFIXES = ['REPLACE_WITH_'] as const

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0
}

function assertBenchmarkConfig(data: unknown, path: string): asserts data is BenchmarkConfig {
  if (!isRecord(data)) {
    throw new TypeError(`config must be a mapping: ${path}`)
  }
  if (!isRecord(data.generation) || Object.keys(data.generation).length === 0) {
    throw new TypeError('config generation settings must be non-empty')
  }
  if (
    !Array.isArray(data.prompt_ids) ||
    data.prompt_ids.length === 0 ||
    !data.prompt_ids.every(isNonEmptyString)
  ) {
    throw new TypeError('config prompt_ids must contain non-empty prompt IDs')
  }
  if (!Array.isArray(data.providers) || data.providers.length === 0) {
    throw new TypeError('config providers must be non-empty')
  }
  for (const provider of data.providers) {
    if (
      !isRecord(provider) ||
      !isNonEmptyString(provider.id) ||
      !isNonEmptyString(provider.base_url) ||
      !isNonEmptyString(provider.model)
    ) {
      throw new TypeError('each config provider must define non-empty id, base_url, and model')
    }
  }
  if (!isRecord(data.model_parity) || !isNonEmptyString(data.model_parity.gguf_path)) {
    throw new TypeError('config model_parity.gguf_path must be non-empty')
  }
  if (!isAbsolute(data.model_parity.gguf_path)) {
    throw new TypeError('config model_parity.gguf_path must be absolute')
  }
  if (
    typeof data.model_parity.sha256 !== 'string' ||
    !/^[0-9a-f]{64}$/.test(data.model_parity.sha256)
  ) {
    throw new TypeError('config model_parity.sha256 must be a lowercase 64-character digest')
  }
}

export function loadBenchmarkConfig(path: string): BenchmarkConfig {
  const data: unknown = loadYaml(readFileSync(path, 'utf8'))
  assertBenchmarkConfig(data, path)
  return data
}

export function configPlaceholders(config: BenchmarkConfig): string[] {
  const bad: string[] = []
  for (const provider of config.providers) {
    for (const key of ['model', 'base_url'] as const) {
      const value = String(provider[key] ?? '')
      if (PLACEHOLDER_PREFIXES.some((prefix) => value.startsWith(prefix))) {
        bad.push(`providers.${provider.id}.${key}`)
      }
    }
  }
  const gguf = String(config.model_parity.gguf_path ?? '')
  if (!gguf || PLACEHOLDER_PREFIXES.some((prefix) => gguf.startsWith(prefix))) {
    bad.push('model_parity.gguf_path')
  }
  return bad
}
