const QUANT = /[-_.]((?:I?Q|PQ)\d\w*|B?F(?:16|32))(?:[-_.]imat)?$/i
const KINDS: Record<string, string> = {
  llm: 'Chat',
  completion: 'Chat',
  'speech-to-text': 'Speech to text',
  'text-to-speech': 'Text to speech',
  embeddings: 'Embeddings',
  translation: 'Translation',
  ocr: 'Text from images'
}

// Splits a GGUF-style name into its family and quantization, e.g. Qwen3.5-2B · 4-bit · Q4_K_M.
export function modelParts(name: string) {
  const match = String(name).match(QUANT)
  if (!match) {
    return { base: name, quant: '', bits: '' }
  }

  const quant = match[1]!.toUpperCase()

  return { base: name.slice(0, match.index), quant, bits: `${quant.match(/\d+/)![0]}-bit` }
}

export function modelKind(model: {
  taskType?: string | null | undefined
  type?: string | undefined
  supportsImages?: boolean | undefined
}) {
  const kind = KINDS[model.taskType || model.type || ''] || model.taskType || model.type || 'Model'
  return model.supportsImages ? `${kind} · images` : kind
}
