import type { GenerationParams } from '@qvac/llm-llamacpp'

export function isTranslatePsyModel(model: { name?: string | undefined; path: string }): boolean {
  const filename = model.path.split(/[/\\]/).pop() ?? ''
  return (
    /^TRANSLATEPSY_AFRISLM_/.test(model.name ?? '') ||
    /^(?:[a-f0-9]{16}_)?TranslatePsy-AfriSLM-(?:0\.8|2|4)B-(?:Q4_K_M|Q8_0)-imat\.gguf$/i.test(
      filename
    )
  )
}

export const TRANSLATEPSY_GENERATION_PARAMS = {
  temp: 0,
  top_k: 1,
  top_p: 1,
  repeat_penalty: 1,
  predict: 256,
  seed: 0,
  reasoning_budget: 0
} satisfies GenerationParams

export function buildTranslatePsyMessages(from: string, to: string, text: string) {
  // Match the model card exactly.
  return [
    {
      role: 'system',
      content:
        `You are a professional ${from} to ${to} translator. ` +
        `Your goal is to accurately convey the meaning and nuances of the ` +
        `original ${from} text while adhering to ${to} grammar, ` +
        `vocabulary, and cultural sensitivities. Produce only the ` +
        `${to} translation, without any additional explanations ` +
        'or commentary. '
    },
    {
      role: 'user',
      content: `Please translate the following ${from} text into ${to}: ${text}.\n\nTranslation:`
    }
  ]
}
