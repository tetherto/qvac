import { z } from 'zod'
import { extractGenerationParams, type GenerationParams } from './common.js'

export const completionsBody = z
  .object({
    model: z.string().min(1),
    prompt: z.union([z.string(), z.array(z.unknown()), z.null()]).optional(),
    stream: z.boolean().optional(),
    temperature: z.number().optional(),
    top_p: z.number().optional(),
    max_tokens: z.number().int().optional()
  })
  .passthrough()

export const COMPLETIONS_UNSUPPORTED_PARAMS = [
  'logit_bias',
  'n',
  'user',
  'seed',
  'logprobs',
  'best_of',
  'echo',
  'suffix',
  'frequency_penalty',
  'presence_penalty',
  'stop'
] as const

export class InvalidPromptError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'InvalidPromptError'
  }
}

export type LegacyPrompt = { kind: 'single'; value: string } | { kind: 'multi'; values: string[] }

export function parseLegacyPrompt(raw: unknown): LegacyPrompt {
  if (raw === undefined || raw === null) {
    throw new InvalidPromptError('"prompt" is required.')
  }

  if (typeof raw === 'string') {
    if (raw.length === 0) {
      throw new InvalidPromptError('"prompt" must be a non-empty string.')
    }
    return { kind: 'single', value: raw }
  }

  if (typeof raw === 'number') {
    throw new InvalidPromptError('Token-id prompts are not supported. Pass a string.')
  }

  if (Array.isArray(raw)) {
    if (raw.length === 0) {
      throw new InvalidPromptError('"prompt" array must not be empty.')
    }

    if (raw.every((p) => typeof p === 'string')) {
      const values = raw as string[]
      if (values.some((v) => v.length === 0)) {
        throw new InvalidPromptError('"prompt" array entries must be non-empty strings.')
      }
      if (values.length === 1) {
        return { kind: 'single', value: values[0]! }
      }
      return { kind: 'multi', values }
    }

    throw new InvalidPromptError(
      'Token-id prompts are not supported. Pass a string or an array of strings.'
    )
  }

  throw new InvalidPromptError('"prompt" must be a string or an array of strings.')
}

export function legacyPromptToHistory(prompt: string): Array<{ role: string; content: string }> {
  return [{ role: 'user', content: prompt }]
}

export type CompletionsBody = z.infer<typeof completionsBody>

export interface SdkCompletionsArgs {
  prompt: LegacyPrompt
  generationParams: GenerationParams | undefined
  stream: boolean
}

export function toSdkCompletionsArgs(body: CompletionsBody): SdkCompletionsArgs {
  return {
    prompt: parseLegacyPrompt(body.prompt),
    generationParams: extractGenerationParams(body as Record<string, unknown>),
    stream: Boolean(body.stream)
  }
}
