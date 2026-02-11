'use strict'

const Corestore = require('corestore')
const HyperDriveDL = require('@qvac/dl-hyperdrive')
const LlmLlamacpp = require('../index')
const process = require('bare-process')

// Helper functions
function createSeparator (char = '=', length = 80) {
  return char.repeat(length)
}

function extractToolCallsQwen (response) {
  const toolCalls = []
  const toolCallRegex = /<tool_call>([\s\S]*?)<\/tool_call>/g
  let match
  while ((match = toolCallRegex.exec(response)) !== null) {
    try {
      const toolCallJson = match[1].trim()
      const toolCall = JSON.parse(toolCallJson)
      toolCalls.push(toolCall)
    } catch (e) {
      // Skip invalid JSON
    }
  }
  return toolCalls
}

const extractToolCallsLFM = (response) => {
  const toolCallParts = response.split(']')
  if (toolCallParts.length < 2) {
    return []
  }
  const toolCallsStr = toolCallParts.slice(0, -1).join(']').concat(']')
  try {
    const toolCalls = JSON.parse(toolCallsStr)
    return toolCalls
  } catch (e) {
    console.error('ERROR: extractToolCallsLFM: unable to extract toolCalls\n')
    console.error(toolCallsStr)
    console.error(e)
  }
  return []
}

async function runQuery (model, query, extractToolCalls) {
  console.log(`\n${createSeparator()}`)
  console.log(query.name)
  console.log(createSeparator())
  console.log('\nThinking and Response:')
  console.log(createSeparator('-'))

  const response = await model.run(query.prompt)
  let fullResponse = ''

  await response
    .onUpdate(data => {
      process.stdout.write(data)
      fullResponse += data
    })
    .await()

  console.log('\n')
  console.log(createSeparator('-'))
  console.log('\nFull Response:')
  console.log(fullResponse)
  console.log(`\nInference Stats: ${JSON.stringify(response.stats, null, 2)}`)
  console.log('\n')

  return { name: query.name, toolCalls: extractToolCalls(fullResponse) }
}

function printToolCallSummary (results) {
  console.log(`\n${createSeparator()}`)
  console.log('Tool Call Summary')
  console.log(createSeparator())
  for (const result of results) {
    console.log(`\n${result.name}:`)
    if (result.toolCalls.length === 0) {
      console.log('  No tool calls found')
    } else {
      for (const toolCall of result.toolCalls) {
        console.log(`  ${toolCall.name} ${JSON.stringify(toolCall.arguments)}`)
      }
    }
  }
  console.log(`\n${createSeparator()}`)
}

const modelMap = {
  'LFM': {
    hdKey: 'f41503e44a2c0a537d9a9665984cb2d87eb2216e6301e898ffea60f5ce6c904d',
    modelName: 'LFM2.5-1.2B-Instruct-Q4_K_M.gguf',
    extractToolCalls: extractToolCallsLFM,
  },
  'Qwen3': {
    hdKey: '05d3d7ad9cd650f53c28f85e312ef09a645dd487845897958b3be8a19cb3aab9',
    modelName: 'Qwen3-1.7B-Q4_0.gguf',
    extractToolCalls: extractToolCallsQwen,
  }
}

async function main () {
  console.log('Tool Calling Example: Demonstrates tool calling capabilities')
  console.log('============================================================')

  // 1. Initializing data loader
  const store = new Corestore('./store')
  const hdStore = store.namespace('hd')

  // CHANGE ME
  const { hdKey, modelName, extractToolCalls } = modelMap['LFM']
  // const { hdKey, modelName, extractToolCalls } = modelMap['Qwen3']

  const hdDL = new HyperDriveDL({
    key: `hd://${hdKey}`,
    store: hdStore
  })

  // 2. Configuring model settings
  const args = {
    loader: hdDL,
    opts: { stats: true },
    logger: console,
    modelName,
    diskPath: './models'
  }

  const config = {
    device: 'gpu',
    gpu_layers: '999',
    ctx_size: '2048',
    tools: 'true'
  }

  // 3. Loading model
  await hdDL.ready()
  const model = new LlmLlamacpp(args, config)
  const closeLoader = true
  let totalProgress = 0
  const reportProgressCallback = (report) => {
    if (typeof report === 'object' && Number(report.overallProgress) > totalProgress) {
      process.stdout.write(
        `\r${report.overallProgress}%: ${report.action} [${report.filesProcessed}/${report.totalFiles}] ${report.currentFileProgress}% ${report.currentFile}`
      )
      if (Number(report.currentFileProgress) === 100) {
        process.stdout.write('\n')
      }
      totalProgress = Number(report.overallProgress)
    }
  }
  await model.load(closeLoader, reportProgressCallback)

  try {
    // 4. Defining tool queries with function schemas
    const systemMessageAmbiguous = {
      role: 'system',
      content: 'You are a helpful assistant with access to various tools. If request is ambiguous,skip tool calls. Output function calls as JSON.'
      // content: 'Output function calls as JSON. You are a helpful assistant with access to various tools. If request is ambiguous,skip tool calls.'
    }

    const tools1 = [
      // Test handled by this function:
      // - Multiple parameters with different types
      // - Complex multiple tools with array parameters
      {
        type: 'function',
        name: 'searchProducts',
        description: 'Search products',
        parameters: {
          type: 'object',
          properties: {
            query: { type: 'string', description: 'Query' },
            category: { type: 'string', enum: ['electronics', 'clothing', 'books'], description: 'Category' },
            maxPrice: { type: 'number', minimum: 0, description: 'Max price' }
          },
          required: ['query']
        }
      },
      // Test handled by this function:
      // - Part of Complex multiple tools with array parameters test
      {
        type: 'function',
        name: 'addToCart',
        description: 'Add items to cart',
        parameters: {
          type: 'object',
          properties: {
            items: {
              type: 'array',
              items: {
                type: 'object',
                properties: {
                  productId: { type: 'string', description: 'Product ID' },
                  quantity: { type: 'integer', minimum: 1, description: 'Quantity' }
                },
                required: ['productId', 'quantity']
              }
            }
          },
          required: ['items']
        }
      },
      // Test handled by this function:
      // - Tool with boolean and optional parameters
      // - Part of Complex multiple tools with nested object parameters test
      {
        type: 'function',
        name: 'queryDB',
        description: 'Query database',
        parameters: {
          type: 'object',
          properties: {
            table: { type: 'string', description: 'Table' },
            conditions: {
              type: 'object',
              properties: {
                field: { type: 'string', description: 'Field' },
                operator: { type: 'string', enum: ['equals', 'greaterThan'], description: 'Operator' },
                value: { type: 'string', description: 'Value' }
              },
              required: ['field', 'operator', 'value']
            },
            limit: { type: 'integer', minimum: 1, default: 10, description: 'Limit' },
            includeMetadata: { type: 'boolean', default: false, description: 'Include metadata' }
          },
          required: ['table', 'conditions']
        }
      }

    ]

    const toolsFirstQuery1 = [
      {
        ...systemMessageAmbiguous,
        content: systemMessageAmbiguous.content.concat(`List of tools: ${JSON.stringify(tools1)}`)
      },
      {
        role: 'user',
        content: 'Search laptops under $1000 and add 2 with ID "laptop-123" to cart. Also, query users table age > 25 limit 50 with metadata.'
      }
    ]
    const toolsLastQuery1 = [
      systemMessageAmbiguous,
      {
        role: 'user',
        content: 'Search laptops under $1000 and add 2 with ID "laptop-123" to cart. Also, query users table age > 25 limit 50 with metadata.'
      },
      ...tools1
    ]

    const tools2 = [
      // Test handled by this function:
      // - Math/computation tool
      {
        type: 'function',
        name: 'calculate',
        description: 'Calculate math',
        parameters: {
          type: 'object',
          properties: {
            expression: { type: 'string', description: 'Expression' },
            precision: { type: 'integer', minimum: 0, maximum: 10, default: 2, description: 'Precision' }
          },
          required: ['expression']
        }
      },
      // Test handled by this function:
      // - Invalid/ambiguous query
      {
        type: 'function',
        name: 'calculateDistance',
        description: 'Calculate distance between two coordinates',
        parameters: {
          type: 'object',
          properties: {
            lat1: { type: 'number', description: 'Latitude of point 1' },
            lon1: { type: 'number', description: 'Longitude of point 1' },
            lat2: { type: 'number', description: 'Latitude of point 2' },
            lon2: { type: 'number', description: 'Longitude of point 2' }
          },
          required: ['lat1', 'lon1', 'lat2', 'lon2']
        }
      }
    ]

    const toolsFirstQuery2 = [
      systemMessageAmbiguous,
      ...tools2,
      {
        role: 'user',
        content: 'calculate 156 * 23 precision 0. Also, How far is here from there?'
      }
    ]

    const toolsLastQuery2 = [
      systemMessageAmbiguous,
      {
        role: 'user',
        content: 'calculate 156 * 23 precision 0. Also, How far is here from there?'
      },
      ...tools2
    ]

    const tools3 = [
      // Test handled by this function:
      // - Part of conversation context tool test
      {
        type: 'function',
        name: 'getWeather',
        description: 'Get weather forecast for a city',
        parameters: {
          type: 'object',
          properties: {
            city: { type: 'string', description: 'City name' },
            date: { type: 'string', description: 'Date in YYYY-MM-DD' }
          },
          required: ['city', 'date']
        }
      },
      // Test handled by this function:
      // - Part of conversation context tool test
      {
        type: 'function',
        name: 'createCalendarEvent',
        description: 'Create a calendar event',
        parameters: {
          type: 'object',
          properties: {
            title: { type: 'string', description: 'Event title' },
            date: { type: 'string', description: 'Event date (YYYY-MM-DD)' },
            time: { type: 'string', description: 'Start time (HH:MM)' },
            duration: { type: 'integer', description: 'Duration in minutes' }
          },
          required: ['title', 'date']
        }
      }
    ]

    const toolsFirstQuery3 = [
      {
        role: 'system',
        content: 'You are a personal assistant.'
      },
      ...tools3,
      {
        role: 'user',
        content: 'What is the weather in Seattle on April 10th?'
      },
      {
        role: 'assistant',
        content: 'Let me check that for you. Do you need hourly or just daily?'
      },
      {
        role: 'user',
        content: 'Daily is fine. Also, schedule a team meeting on April 10th at 2 PM for 60 minutes.'
      }
    ]

    const toolsLastQuery3 = [
      {
        role: 'system',
        content: 'You are a personal assistant.'
      },
      {
        role: 'user',
        content: 'What is the weather in Seattle on April 10th?'
      },
      {
        role: 'assistant',
        content: 'Let me check that for you. Do you need hourly or just daily?'
      },
      {
        role: 'user',
        content: 'Daily is fine. Also, schedule a team meeting on April 10th at 2 PM for 60 minutes.'
      },
      ...tools3
    ]

    // 5. Running tool calling queries
    const queries = [
      { name: 'Query 1 (tools first): Complex tool calling with multiple parameters', prompt: toolsFirstQuery1 },
      // { name: 'Query 1 (tools last): Complex tool calling with multiple parameters', prompt: toolsLastQuery1 },
      // { name: 'Query 2 (tools first): Math calculation and ambiguous query', prompt: toolsFirstQuery2 },
      // { name: 'Query 2 (tools last): Math calculation and ambiguous query', prompt: toolsLastQuery2 },
      // { name: 'Query 3 (tools first): Conversation context with tools', prompt: toolsFirstQuery3 },
      // { name: 'Query 3 (tools last): Conversation context with tools', prompt: toolsLastQuery3 }
    ]

    const toolCallResults = []
    for (const query of queries) {
      const result = await runQuery(model, query, extractToolCalls)
      toolCallResults.push(result)
    }

    // Print all tool calls together at the end
    printToolCallSummary(toolCallResults)
  } catch (error) {
    const errorMessage = error?.message || error?.toString() || String(error)
    console.error('Error occurred:', errorMessage)
    console.error('Error details:', error)
  } finally {
    // 6. Cleaning up resources
    await store.close()
    await hdDL.close()
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
