'use strict'

const LlmLlamacpp = require('../index')
const path = require('bare-path')
const process = require('bare-process')
const { downloadModel } = require('./utils')

const MAX_TOOL_TURNS = 5

function parseHarmonyToolCall (rawText) {
  const match = rawText.match(
    /commentary to=functions\.(\w+)\s+<\|constrain\|>json<\|message\|>(\{[^}]*\})<\|call\|>/
  )
  if (!match) return null
  try {
    return { name: match[1], arguments: JSON.parse(match[2]) }
  } catch {
    return null
  }
}

function simulateToolExecution (name, args) {
  if (name === 'get_weather') {
    return JSON.stringify({
      city: args.city,
      country: args.country || 'unknown',
      temperature: '22°C',
      condition: 'Partly cloudy',
      wind: '12 km/h from the east',
      humidity: '65%'
    })
  }
  if (name === 'get_horoscope') {
    return JSON.stringify({
      sign: args.sign,
      horoscope: 'Today is a great day for new beginnings. Your curiosity leads to fresh insights.'
    })
  }
  return JSON.stringify({ error: `Unknown tool: ${name}` })
}

async function main () {
  console.log('Harmony Multi-Turn Tool Calling Example')
  console.log('========================================')
  console.log('GPT-OSS emits one tool call per turn, ending with <|call|>.')
  console.log('This example demonstrates the full multi-turn loop.\n')

  // 1. Downloading model
  const [modelName, dirPath] = await downloadModel(
    'https://huggingface.co/unsloth/gpt-oss-20b-GGUF/resolve/main/gpt-oss-20b-Q4_K_M.gguf',
    'gpt-oss-20b-Q4_K_M.gguf'
  )

  // 2. Configuring model settings
  const modelPath = path.join(dirPath, modelName)

  const config = {
    device: 'cpu',
    gpu_layers: '0',
    ctx_size: '4096',
    tools: 'true'
  }

  // 3. Loading model
  const model = new LlmLlamacpp({
    files: { model: [modelPath] },
    config,
    logger: console,
    opts: { stats: true }
  })
  await model.load()

  const toolDefs = [
    {
      type: 'function',
      name: 'get_weather',
      description: 'Get current weather for a city',
      parameters: {
        type: 'object',
        properties: {
          city: { type: 'string', description: 'City name' },
          country: { type: 'string', description: 'Country code' }
        },
        required: ['city']
      }
    },
    {
      type: 'function',
      name: 'get_horoscope',
      description: "Get today's horoscope for an astrological sign",
      parameters: {
        type: 'object',
        properties: {
          sign: { type: 'string', description: 'An astrological sign like Taurus or Aquarius' }
        },
        required: ['sign']
      }
    }
  ]

  const history = [
    { role: 'system', content: 'You are a helpful assistant that can use tools to get the weather and horoscope.' },
    ...toolDefs,
    { role: 'user', content: "What's the weather in Tokyo and my horoscope for Aquarius?" }
  ]

  try {
    // 4. Running multi-turn tool calling loop
    let turn = 0
    while (turn < MAX_TOOL_TURNS) {
      turn++
      console.log(`\n--- Turn ${turn} ---`)

      const response = await model.run(history)
      let fullResponse = ''

      await response
        .onUpdate(data => { fullResponse += data })
        .await()

      console.log(`[output length] ${fullResponse.length}`)
      console.log(`[tail]          ...${fullResponse.slice(-120)}`)

      const hasCall = fullResponse.includes('<|call|>')
      console.log(`[has <|call|>]  ${hasCall}`)

      if (!hasCall) {
        console.log('\n[DONE] Model produced final response.\n')
        const finalMatch = fullResponse.match(/<\|channel\|>final<\|message\|>([\s\S]*?)$/)
        if (finalMatch) {
          console.log('=== FINAL RESPONSE ===')
          console.log(finalMatch[1])
          console.log('=== END ===')
        } else {
          console.log('=== RAW OUTPUT (last 500) ===')
          console.log(fullResponse.slice(-500))
          console.log('=== END ===')
        }
        break
      }

      const toolCall = parseHarmonyToolCall(fullResponse)
      if (!toolCall) {
        console.log('[ERROR] <|call|> present but could not parse tool call.')
        console.log(fullResponse)
        break
      }

      console.log(`[tool call]    ${toolCall.name}(${JSON.stringify(toolCall.arguments)})`)

      const toolResult = simulateToolExecution(toolCall.name, toolCall.arguments)
      console.log(`[tool result]  ${toolResult}`)

      history.push({ role: 'assistant', content: fullResponse })
      history.push({ role: 'tool', content: toolResult })
    }

    if (turn >= MAX_TOOL_TURNS) {
      console.log(`\n[WARN] Reached max turns (${MAX_TOOL_TURNS}) without final response.`)
    }

    console.log(`\n--- Conversation (${history.length} messages) ---`)
    for (const msg of history) {
      const preview = msg.content
        ? msg.content.slice(0, 80).replace(/\n/g, '\\n')
        : `[${msg.type}: ${msg.name}]`
      console.log(`  [${msg.role || msg.type}] ${preview}`)
    }

    // 5. Parallel tool calling test
    console.log('\n\n========================================')
    console.log('PARALLEL TOOL CALL TEST')
    console.log('========================================')
    console.log('Testing if model can emit multiple tool calls in a single generation...\n')

    const parallelHistory = [
      { role: 'system', content: 'You are a helpful assistant. Call ALL required tools in a single response.' },
      ...toolDefs,
      { role: 'user', content: 'I need both: weather in Tokyo AND horoscope for Aquarius. Call both tools now.' }
    ]

    const parallelResponse = await model.run(parallelHistory)
    let parallelOutput = ''

    await parallelResponse
      .onUpdate(data => { parallelOutput += data })
      .await()

    const callCount = (parallelOutput.match(/<\|call\|>/g) || []).length
    const toolFrames = parallelOutput.match(/commentary to=functions\.\w+/g) || []

    console.log(`[output length]     ${parallelOutput.length}`)
    console.log(`[<|call|> count]    ${callCount}`)
    console.log(`[tool frames found] ${toolFrames.length} (${toolFrames.join(', ')})`)
    console.log(`[raw tail]          ...${parallelOutput.slice(-150)}`)

    if (callCount > 1) {
      console.log('\n[RESULT] PARALLEL SUPPORTED — model emitted multiple tool calls in one pass.')
    } else if (callCount === 1) {
      console.log('\n[RESULT] PARALLEL NOT SUPPORTED — model emits exactly one tool call per generation.')
      console.log('         GPT-OSS uses sequential multi-turn tool calling (one <|call|> per turn).')
    } else {
      console.log('\n[RESULT] UNEXPECTED — no <|call|> found in output.')
      console.log(`[raw output]\n${parallelOutput}`)
    }
  } catch (error) {
    const errorMessage = error?.message || error?.toString() || String(error)
    console.error('Error occurred:', errorMessage)
    console.error('Error details:', error)
  } finally {
    // 6. Cleaning up resources
    await model.unload()
  }
}

main().catch(error => {
  console.error('Fatal error in main function:', {
    error: error.message,
    stack: error.stack,
    timestamp: new Date().toISOString()
  })
  process.exit(1)
})
