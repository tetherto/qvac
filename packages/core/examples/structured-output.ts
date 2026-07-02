// Per-request structured output via `responseFormat`. A JSON Schema forces the
// model to emit an object with exactly the given keys.
//
// Run: bare examples/structured-output.ts
// Requires: npm install @qvac/core @qvac/llm-llamacpp bare-stdio

import io from 'bare-stdio'
import { registerPlugin, loadModel, completion, unloadModel, QWEN3_600M_INST_Q4 } from '@qvac/core'
import { llmPlugin } from '@qvac/core/llamacpp-completion/plugin'

registerPlugin(llmPlugin)

const PERSON_SCHEMA = {
  type: 'object',
  properties: {
    name: { type: 'string' },
    age: { type: 'integer' },
    occupation: { type: 'string' }
  },
  required: ['name', 'age', 'occupation'],
  additionalProperties: false
} as const

const HISTORY = [
  {
    role: 'system',
    content: 'You extract structured information about people from short bios. /no_think'
  },
  { role: 'user', content: "Hi, I'm Alice, I'm 30 years old and I work as a data engineer." }
]

// Drain the run via the canonical `events` / `final` surface and return the
// aggregated content text.
async function runToContent(run: ReturnType<typeof completion>): Promise<string> {
  for await (const event of run.events) {
    if (event.type === 'contentDelta') io.out.write(event.text)
  }
  const final = await run.final
  io.out.write('\n')
  return final.contentText
}

try {
  const modelId = await loadModel({ modelSrc: QWEN3_600M_INST_Q4 })
  console.log(`▸ Model loaded: ${modelId}\n`)

  console.log('▸ responseFormat: json_schema (strict shape)')
  const out = await runToContent(
    completion({
      modelId,
      history: HISTORY,
      stream: true,
      responseFormat: {
        type: 'json_schema',
        json_schema: { name: 'person', schema: PERSON_SCHEMA }
      }
    })
  )
  console.log('▸ parsed:', JSON.parse(out.trim()))

  await unloadModel({ modelId, autoClose: true })
} catch (error) {
  console.error('✖', error)
}
