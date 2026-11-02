import { readFileSync } from 'node:fs'
import { isAbsolute } from 'node:path'
import { load as loadYaml } from 'js-yaml'
import type { BenchmarkConfig, PromptDoc, PromptsFile } from './types'

export const PLACEHOLDER_PREFIXES = ['REPLACE_WITH_'] as const
const ROOT_KEYS = new Set([
  'session_dir',
  'cooldown_seconds',
  'warmup_runs',
  'measured_runs',
  'api_key',
  'generation',
  'parity_prompt_id',
  'prompt_ids',
  'providers',
  'model_parity'
])
const GENERATION_KEYS = new Set(['max_tokens', 'temperature', 'seed', 'stream', 'stream_options'])
const STREAM_OPTION_KEYS = new Set(['include_usage'])
const PROVIDER_KEYS = new Set(['id', 'base_url', 'model', 'lifecycle'])
const LIFECYCLE_KEYS = new Set(['start_command', 'stop_command', 'timeout_seconds'])

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value)
}

function isNonNegativeInteger(value: unknown): value is number {
  return isFiniteNumber(value) && Number.isInteger(value) && value >= 0
}

function assertGenerationConfig(value: unknown): void {
  if (!isRecord(value) || Object.keys(value).length === 0) {
    throw new TypeError('config generation settings must be non-empty')
  }
  for (const key of Object.keys(value)) {
    if (!GENERATION_KEYS.has(key)) {
      throw new TypeError(`unknown config generation setting: ${key}`)
    }
  }
  if (
    'max_tokens' in value &&
    (!isFiniteNumber(value['max_tokens']) ||
      !Number.isInteger(value['max_tokens']) ||
      value['max_tokens'] <= 0)
  ) {
    throw new TypeError('config generation.max_tokens must be a positive integer')
  }
  if (
    'temperature' in value &&
    (!isFiniteNumber(value['temperature']) || value['temperature'] < 0 || value['temperature'] > 2)
  ) {
    throw new TypeError('config generation.temperature must be between 0 and 2')
  }
  if (
    'seed' in value &&
    value['seed'] !== null &&
    (!isFiniteNumber(value['seed']) || !Number.isInteger(value['seed']))
  ) {
    throw new TypeError('config generation.seed must be an integer or null')
  }
  if ('stream' in value && value['stream'] !== true) {
    throw new TypeError('config generation.stream must be true')
  }
  if ('stream_options' in value) {
    if (!isRecord(value['stream_options'])) {
      throw new TypeError('config generation.stream_options must be a mapping')
    }
    const streamOptions = value['stream_options']
    for (const key of Object.keys(streamOptions)) {
      if (!STREAM_OPTION_KEYS.has(key)) {
        throw new TypeError(`unknown config generation.stream_options setting: ${key}`)
      }
    }
    if ('include_usage' in streamOptions && typeof streamOptions['include_usage'] !== 'boolean') {
      throw new TypeError('config generation.stream_options.include_usage must be a boolean')
    }
  }
}

function assertProviderLifecycle(value: unknown): void {
  if (!isRecord(value)) {
    throw new TypeError('config provider lifecycle must be a mapping')
  }
  for (const key of Object.keys(value)) {
    if (!LIFECYCLE_KEYS.has(key)) {
      throw new TypeError(`unknown config provider lifecycle setting: ${key}`)
    }
  }
  for (const key of ['start_command', 'stop_command'] as const) {
    if (key in value) {
      const command = value[key]
      if (!Array.isArray(command) || command.length === 0 || !command.every(isNonEmptyString)) {
        throw new TypeError(
          `config provider lifecycle.${key} must be a non-empty array of non-empty strings`
        )
      }
    }
  }
  if (
    'timeout_seconds' in value &&
    (!isFiniteNumber(value['timeout_seconds']) || value['timeout_seconds'] <= 0)
  ) {
    throw new TypeError('config provider lifecycle.timeout_seconds must be a positive number')
  }
}

function assertBenchmarkConfig(data: unknown, path: string): asserts data is BenchmarkConfig {
  if (!isRecord(data)) {
    throw new TypeError(`config must be a mapping: ${path}`)
  }
  for (const key of Object.keys(data)) {
    if (!ROOT_KEYS.has(key)) {
      throw new TypeError(`unknown config setting: ${key}`)
    }
  }
  for (const key of ['session_dir', 'api_key', 'parity_prompt_id'] as const) {
    if (key in data && !isNonEmptyString(data[key])) {
      throw new TypeError(`config ${key} must be a non-empty string`)
    }
  }
  assertGenerationConfig(data['generation'])
  if ('warmup_runs' in data && !isNonNegativeInteger(data['warmup_runs'])) {
    throw new TypeError('config warmup_runs must be a non-negative integer')
  }
  if (
    'measured_runs' in data &&
    (!isNonNegativeInteger(data['measured_runs']) || data['measured_runs'] === 0)
  ) {
    throw new TypeError('config measured_runs must be a positive integer')
  }
  if (
    'cooldown_seconds' in data &&
    (!isFiniteNumber(data['cooldown_seconds']) || data['cooldown_seconds'] < 0)
  ) {
    throw new TypeError('config cooldown_seconds must be a non-negative number')
  }
  if (
    !Array.isArray(data['prompt_ids']) ||
    data['prompt_ids'].length === 0 ||
    !data['prompt_ids'].every(isNonEmptyString)
  ) {
    throw new TypeError('config prompt_ids must contain non-empty prompt IDs')
  }
  if (!Array.isArray(data['providers']) || data['providers'].length === 0) {
    throw new TypeError('config providers must be non-empty')
  }
  for (const provider of data['providers']) {
    if (
      !isRecord(provider) ||
      !isNonEmptyString(provider['id']) ||
      !isNonEmptyString(provider['base_url']) ||
      !isNonEmptyString(provider['model'])
    ) {
      throw new TypeError('each config provider must define non-empty id, base_url, and model')
    }
    for (const key of Object.keys(provider)) {
      if (!PROVIDER_KEYS.has(key)) {
        throw new TypeError(`unknown config provider setting: ${key}`)
      }
    }
    if ('lifecycle' in provider) {
      assertProviderLifecycle(provider['lifecycle'])
    }
  }
  if (!isRecord(data['model_parity'])) {
    throw new TypeError('config model_parity.gguf_path must be non-empty')
  }
  const modelParity = data['model_parity']
  const ggufPath = modelParity['gguf_path']
  if (!isNonEmptyString(ggufPath)) {
    throw new TypeError('config model_parity.gguf_path must be non-empty')
  }
  if (!isAbsolute(ggufPath)) {
    throw new TypeError('config model_parity.gguf_path must be absolute')
  }
  const sha256 = modelParity['sha256']
  if (
    sha256 !== undefined &&
    sha256 !== '' &&
    (typeof sha256 !== 'string' || !/^[0-9a-f]{64}$/.test(sha256))
  ) {
    throw new TypeError('config model_parity.sha256 must be a lowercase 64-character digest')
  }
}

export function loadBenchmarkConfig(path: string): BenchmarkConfig {
  const data: unknown = loadYaml(readFileSync(path, 'utf8'))
  assertBenchmarkConfig(data, path)
  return data
}

export function loadPrompts(path: string): PromptsFile {
  const data = JSON.parse(readFileSync(path, 'utf8')) as PromptsFile
  if (!data.parity || !Array.isArray(data.prompts)) {
    throw new Error('prompts.json must contain parity and prompts')
  }
  return data
}

export function promptById(promptsDoc: PromptsFile, promptId: string): PromptDoc {
  if (promptId === promptsDoc.parity.id) {
    return { ...promptsDoc.parity }
  }
  const found = promptsDoc.prompts.find((prompt) => prompt.id === promptId)
  if (!found) {
    throw new Error(`unknown prompt id: ${promptId}`)
  }
  return { ...found }
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
