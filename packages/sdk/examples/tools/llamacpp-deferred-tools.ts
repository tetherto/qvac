// Deferred tool loading: a large tool set stays out of the prompt until the
// model asks for it. Only `get_weather` and the built-in `tool_search` (whose
// description carries a name-and-description catalog of the rest) are in the
// initial prompt; the deferred schemas arrive in the conversation when the
// model searches for them.
import {
  TOOL_SEARCH_NAME,
  completion,
  executeToolSearch,
  loadModel,
  unloadModel,
  type ToolInput,
  QWEN3_1_7B_INST_Q4
} from '@qvac/sdk'
import { z } from 'zod'
import { weatherSchema, horoscopeSchema, mockExecute } from './shared'

const tools: ToolInput[] = [
  {
    name: 'get_weather',
    description: 'Get current weather for a city',
    parameters: weatherSchema
  },
  {
    name: 'get_horoscope',
    description: "Get today's horoscope for an astrological sign",
    parameters: horoscopeSchema,
    deferLoading: true,
    group: 'astrology'
  },
  {
    name: 'get_moon_phase',
    description: 'Get the current phase of the moon',
    parameters: z.object({ date: z.string().describe('ISO date').optional() }),
    deferLoading: true,
    group: 'astrology'
  }
]

try {
  const modelId = await loadModel({
    modelSrc: QWEN3_1_7B_INST_Q4,
    modelConfig: { ctx_size: 4096, tools: true }
  })
  console.log(`▸ Model loaded. Model ID: ${modelId}`)

  const history = [
    {
      role: 'system',
      content: 'You are a helpful assistant. Search for a tool before calling it.'
    },
    { role: 'user', content: "What's my horoscope for Aquarius?" }
  ]

  console.log('\n▸ Turn 1 — only get_weather and tool_search are in the prompt\n')
  const first = completion({ modelId, history, stream: true, tools })
  for await (const token of first.tokenStream) process.stdout.write(token)

  const calls = await first.toolCalls
  const search = calls.find((call) => call.name === TOOL_SEARCH_NAME)
  if (!search) {
    console.log('\n\n▸ The model answered without searching; nothing more to show.')
  } else {
    console.log(`\n\n▸ The model searched: ${JSON.stringify(search.arguments)}`)

    // Running the search is the SDK's job, not a tool handler's. The result is
    // an ordinary tool message: appending it is what makes the definitions
    // callable on the next turn.
    history.push({ role: 'assistant', content: await first.text })
    history.push({
      role: 'tool',
      content: executeToolSearch(tools, search.arguments, history)
    })

    console.log('▸ Definitions appended. Turn 2 — the model can now call them directly.\n')
    const second = completion({ modelId, history, stream: true, tools })
    for await (const token of second.tokenStream) process.stdout.write(token)

    for (const call of await second.toolCalls) {
      console.log(`\n\n▸ Tool call: ${call.name}(${JSON.stringify(call.arguments)})`)
      console.log(`▸ Result: ${mockExecute(call.name, call.arguments)}`)
    }
  }

  console.log('\n\n▸ Completed!')
  await unloadModel({ modelId, clearStorage: false })
} catch (error) {
  console.error('✖', error)
  process.exit(1)
}
