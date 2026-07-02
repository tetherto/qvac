// Tool calling. Tools are declared as Zod schemas and passed to `completion`;
// the model streams text and, where supported, emits structured tool calls.
//
// Run: bare examples/tools.ts
// Requires: npm install @qvac/core @qvac/llm-llamacpp bare-stdio zod

import io from 'bare-stdio'
import { z } from 'zod'
import {
  registerPlugin,
  loadModel,
  completion,
  unloadModel,
  type ToolInput,
  QWEN3_1_7B_INST_Q4
} from '@qvac/core'
import { llmPlugin } from '@qvac/core/llamacpp-completion/plugin'

registerPlugin(llmPlugin)

const tools: ToolInput[] = [
  {
    name: 'get_weather',
    description: 'Get current weather for a city',
    parameters: z.object({ city: z.string().describe('City name') })
  }
]

try {
  const modelId = await loadModel({
    modelSrc: QWEN3_1_7B_INST_Q4,
    modelConfig: { ctx_size: 4096, tools: true }
  })
  console.log(`▸ Model loaded: ${modelId}`)

  const history = [
    { role: 'system', content: 'You are a helpful assistant that can use tools.' },
    { role: 'user', content: "What's the weather in Tokyo?" }
  ]

  const result = completion({ modelId, history, stream: true, tools })

  for await (const token of result.tokenStream) {
    io.out.write(token)
  }
  io.out.write('\n')

  const toolCalls = await result.toolCalls
  for (const call of toolCalls) {
    console.log(`▸ tool call: ${call.name}(${JSON.stringify(call.arguments)})`)
  }

  await unloadModel({ modelId, autoClose: true })
} catch (error) {
  console.error('✖', error)
}
