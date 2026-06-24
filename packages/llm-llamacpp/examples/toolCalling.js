'use strict'

const LlmLlamacpp = require('../index')
const path = require('bare-path')
const process = require('bare-process')
const { downloadModel } = require('./utils')

// Helper functions
function createSeparator (char = '=', length = 80) {
  return char.repeat(length)
}

function extractToolCalls (response) {
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

async function runQuery (model, query) {
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

async function main () {
  console.log('Tool Calling Example: Demonstrates tool calling capabilities')
  console.log('============================================================')

  // 1. Downloading model
  const [modelName, dirPath] = await downloadModel(
    'https://huggingface.co/unsloth/Qwen3-1.7B-GGUF/resolve/main/Qwen3-1.7B-Q4_0.gguf',
    'Qwen3-1.7B-Q4_0.gguf'
  )

  // 2. Configuring model settings
  const modelPath = path.join(dirPath, modelName)

  const config = {
    device: 'gpu',
    gpu_layers: '999',
    ctx_size: '2048',
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

  try {
    // 4. Defining tool queries with function schemas
    const systemMessageAmbiguous = {
      role: 'system',
      content: 'You are a helpful assistant with access to various tools. If request is ambiguous,skip tool calls.'
    }

    const toolQuery1 = [
      systemMessageAmbiguous,
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
      },
      {
        role: 'user',
        content: 'Search laptops under $1000 and add 2 with ID "laptop-123" to cart. Also, query users table age > 25 limit 50 with metadata.'
      }
    ]

    const toolQuery2 = [
      systemMessageAmbiguous,
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
      },
      {
        role: 'user',
        content: 'calculate 156 * 23 precision 0. Also, How far is here from there?'
      }
    ]

    const toolQuery3 = [
      {
        role: 'system',
        content: 'You are a personal assistant.'
      },
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
      }
    ]

    // 5. Running tool calling queries
    const queries = [
      { name: 'Query 1: Complex tool calling with multiple parameters', prompt: toolQuery1 },
      { name: 'Query 2: Math calculation and ambiguous query', prompt: toolQuery2 },
      { name: 'Query 3: Conversation context with tools', prompt: toolQuery3 }
    ]

    const toolCallResults = []
    for (const query of queries) {
      const result = await runQuery(model, query)
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
