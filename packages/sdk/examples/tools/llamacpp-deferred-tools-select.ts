// Choosing which deferred tools a search loads. By default `tool_search` loads
// every tool that shares a word with the query, up to its limit, so a search for
// "http request tool" also loads a tool grouped under `http-request` and one
// whose description mentions "tool results". Running the search client-side,
// `select` sees each match with its score and keeps only those scoring at least
// half of the best one; tools that tie for the top still load together.
import {
  TOOL_SEARCH_NAME,
  completion,
  executeToolSearch,
  loadModel,
  rankDeferredTools,
  unloadModel,
  type RankedTool,
  type Tool,
  type ToolSearchOptions,
  QWEN3_5_2B_MULTIMODAL_Q4_K_M
} from '@qvac/sdk'

function deferred(name: string, description: string, group: string, param: string): Tool {
  return {
    type: 'function',
    name,
    description,
    parameters: {
      type: 'object',
      properties: { [param]: { type: 'string', description: `The ${param}` } },
      required: [param]
    },
    deferLoading: true,
    group
  }
}

const tools: Tool[] = [
  deferred(
    'http_request',
    'Make an outbound HTTP or HTTPS request and return the response status and body as text.',
    'http-request',
    'url'
  ),
  deferred(
    'weather_lookup',
    'Look up the current weather and a three-day forecast for a place.',
    'http-request',
    'location'
  ),
  deferred(
    'generate_image',
    'Generate an image from a text prompt using the local diffusion model.',
    'image',
    'prompt'
  ),
  deferred(
    'edit_image',
    'Edit an image in the chat; attachment ids come from earlier tool results.',
    'image',
    'prompt'
  )
]

function strongMatches(ranked: readonly RankedTool[]): readonly RankedTool[] {
  const best = ranked[0]?.score ?? 0
  return ranked.filter(({ score }) => score >= best / 2)
}

const search: ToolSearchOptions = { select: strongMatches }

function loadedBy(content: string): string[] {
  return (JSON.parse(content) as { tool_search: { loaded: string[] } }).tool_search.loaded
}

function mockFetch(args: Record<string, unknown>): string {
  return JSON.stringify({
    url: args['url'],
    status: 200,
    body: '<html><head><title>Example Domain</title></head></html>'
  })
}

try {
  const modelId = await loadModel({
    modelSrc: QWEN3_5_2B_MULTIMODAL_Q4_K_M,
    modelConfig: { ctx_size: 4096, tools: true }
  })
  console.log(`▸ Model loaded. Model ID: ${modelId}`)

  const history = [
    {
      role: 'system',
      content: 'You are a helpful assistant. Search for a tool before calling it.'
    },
    {
      role: 'user',
      content:
        'Use the tool_search tool to find a tool that can make an HTTP request, then fetch https://example.com and tell me the page title'
    }
  ]

  console.log('\n▸ Turn 1 — only tool_search and its catalog are in the prompt\n')
  const first = completion({ modelId, history, stream: true, tools })
  for await (const token of first.tokenStream) process.stdout.write(token)

  const call = (await first.toolCalls).find((each) => each.name === TOOL_SEARCH_NAME)
  if (!call) {
    console.log('\n\n▸ The model answered without searching; nothing more to show.')
  } else {
    const query = typeof call.arguments['query'] === 'string' ? call.arguments['query'] : ''
    console.log(`\n\n▸ The model searched: ${JSON.stringify(call.arguments)}`)
    for (const { tool, score } of rankDeferredTools(tools, query)) {
      console.log(`  ${String(score).padStart(4)}  ${tool.name}`)
    }

    const result = executeToolSearch(tools, call.arguments, history, search)
    console.log(
      `▸ Default search loads: ${loadedBy(executeToolSearch(tools, call.arguments, history)).join(', ')}`
    )
    console.log(`▸ Strong matches load:  ${loadedBy(result).join(', ')}`)

    console.log('\n▸ Turn 2 — the loaded definitions are declared, so the model can call them\n')
    const second = completion({
      modelId,
      history: [
        ...history,
        {
          role: 'assistant',
          content: '',
          toolCalls: [{ id: call.id, name: call.name, arguments: call.arguments }]
        },
        { role: 'tool', content: result, toolCallId: call.id, toolName: TOOL_SEARCH_NAME }
      ],
      stream: true,
      tools
    })
    for await (const token of second.tokenStream) process.stdout.write(token)

    for (const each of await second.toolCalls) {
      console.log(`\n\n▸ Tool call: ${each.name}(${JSON.stringify(each.arguments)})`)
      console.log(
        `▸ Result: ${each.name === 'http_request' ? mockFetch(each.arguments) : 'not run'}`
      )
    }
  }

  console.log('\n\n▸ Completed!')
  await unloadModel({ modelId, clearStorage: false })
} catch (error) {
  console.error('✖', error)
  process.exit(1)
}
