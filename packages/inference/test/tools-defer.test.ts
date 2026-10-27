import test from 'brittle'
import { z } from 'zod'
import type { Tool } from '@/schemas/tools'
import {
  TOOL_SEARCH_NAME,
  buildCatalog,
  buildToolSearchTool,
  executeToolSearch,
  loadedToolNames,
  partitionTools,
  resolveDeferredTools,
  searchDeferredTools
} from '@/utils/tools/defer'
import { getMcpToolsWithHandlers } from '@/utils/mcp-adapter'
import type { McpClient } from '@/schemas/mcp-adapter'

function tool(name: string, description: string, extra: Partial<Tool> = {}): Tool {
  return {
    type: 'function',
    name,
    description,
    parameters: {
      type: 'object',
      properties: { q: { type: 'string', description: 'a parameter' } },
      required: ['q']
    },
    ...extra
  }
}

const INVENTORY: Tool[] = [
  tool('get_weather', 'Current weather for a city'),
  tool('create_issue', 'Open a new issue on a repository', {
    deferLoading: true,
    group: 'github'
  }),
  tool('list_prs', 'List pull requests on a repository', {
    deferLoading: true,
    group: 'github'
  }),
  tool('read_file', 'Read a file from disk', { deferLoading: true, group: 'filesystem' })
]

test('partitionTools splits on deferLoading', (t) => {
  const { alwaysLoaded, deferred } = partitionTools(INVENTORY)
  t.alike(
    alwaysLoaded.map((item) => item.name),
    ['get_weather']
  )
  t.alike(
    deferred.map((item) => item.name),
    ['create_issue', 'list_prs', 'read_file']
  )
})

test('catalog lists name and description only, grouped, in registration order', (t) => {
  const { deferred } = partitionTools(INVENTORY)
  const catalog = buildCatalog(deferred)

  t.is(
    catalog,
    [
      '[github]',
      '- create_issue: Open a new issue on a repository',
      '- list_prs: List pull requests on a repository',
      '[filesystem]',
      '- read_file: Read a file from disk'
    ].join('\n')
  )
  t.absent(catalog.includes('parameters'), 'no parameter schema in the catalog')
  t.absent(catalog.includes('"q"'), 'no property names in the catalog')
})

test('the prompt carries always-loaded tools and tool_search, never a deferred schema', (t) => {
  const resolved = resolveDeferredTools(INVENTORY, [{ role: 'user', content: 'hi' }])
  t.ok(resolved)

  t.alike(
    resolved?.toolsToRender.map((item) => item.name),
    ['get_weather', TOOL_SEARCH_NAME],
    'only the always-loaded tool and the search tool are rendered'
  )
  const rendered = JSON.stringify(resolved?.toolsToRender)
  t.ok(rendered.includes('create_issue'), 'the deferred tool is named in the catalog')
  t.is(
    rendered.split('"parameters"').length - 1,
    2,
    'exactly two parameter schemas reach the prompt: the always-loaded tool and tool_search'
  )
})

test('resolveDeferredTools returns null when nothing defers', (t) => {
  t.is(resolveDeferredTools([tool('a', 'x')], []), null)
  t.is(resolveDeferredTools(undefined, []), null)
  t.is(resolveDeferredTools([], []), null)
})

test('the catalog is text, not callable tool entries', (t) => {
  const search = buildToolSearchTool(partitionTools(INVENTORY).deferred)
  t.is(search.name, TOOL_SEARCH_NAME)
  t.alike(Object.keys(search.parameters.properties).sort(), ['limit', 'query'])
  t.ok(search.description.includes('create_issue'))
})

test('search prefers an exact name, then text match', (t) => {
  const { deferred } = partitionTools(INVENTORY)

  t.alike(
    searchDeferredTools(deferred, 'list_prs').map((item) => item.name),
    ['list_prs'],
    'an exact name matches only itself'
  )
  t.alike(
    searchDeferredTools(deferred, 'repository').map((item) => item.name),
    ['create_issue', 'list_prs'],
    'a capability query matches on description, in registration order'
  )
  t.alike(searchDeferredTools(deferred, 'nothing here at all'), [], 'no match is empty')
})

test('search honours the limit and clamps it', (t) => {
  const { deferred } = partitionTools(INVENTORY)
  t.is(searchDeferredTools(deferred, 'repository', 1).length, 1)
  t.is(searchDeferredTools(deferred, 'repository', 0).length, 1, 'clamped up to one')
  t.is(searchDeferredTools(deferred, 'repository', 99).length, 2, 'capped by the matches')
})

test('a no-match search tells the model what to do instead of going quiet', (t) => {
  const parsed = JSON.parse(executeToolSearch(INVENTORY, { query: 'nothing here at all' }, [])) as {
    tool_search: { loaded: string[]; hint?: string }
  }
  t.alike(parsed.tool_search.loaded, [])
  t.ok(parsed.tool_search.hint, 'a no-match result carries a hint')
  t.is(
    executeToolSearch(INVENTORY, { query: 'nothing here at all' }, []),
    executeToolSearch(INVENTORY, { query: 'nothing here at all' }, []),
    'and stays byte-identical'
  )
})

test('a hit carries no hint', (t) => {
  const parsed = JSON.parse(executeToolSearch(INVENTORY, { query: 'create_issue' }, [])) as {
    tool_search: { hint?: string }
  }
  t.absent(parsed.tool_search.hint)
})

test('Zod-schema tools are searched and sized in their wire form', (t) => {
  // The ToolInput form a caller passes to `completion()`: `parameters` is a Zod
  // object, not a JSON schema. Serialised raw, a Zod object drops `.describe()`
  // text, so two tools whose JSON schemas overflow the size cap together would
  // both fit if the cap measured the Zod objects.
  const longText = 'x'.repeat(5 * 1024)
  const zodTool = (name: string) => ({
    name,
    description: 'Open a new issue on a repository',
    parameters: z.object({ title: z.string().describe(longText) }),
    deferLoading: true
  })
  t.ok(
    JSON.stringify(zodTool('create_issue').parameters).length < 1024,
    'a raw Zod object leaves the description out'
  )

  const parsed = JSON.parse(
    executeToolSearch([zodTool('create_issue'), zodTool('open_issue')], { query: 'issue' }, [])
  ) as { tool_search: { loaded: string[] } }

  t.alike(parsed.tool_search.loaded, ['create_issue'], 'the cap measures the JSON schemas')
})

test('a search result names what it loaded and carries no schema', (t) => {
  const content = executeToolSearch(INVENTORY, { query: 'create_issue' }, [])

  t.is(
    content,
    '{"tool_search":{"query":"create_issue","loaded":["create_issue"],"already_loaded":[]}}',
    'the schema is declared in the tools block, not repeated in the result'
  )
})

test('a search result from an earlier version, with schemas, still loads its tools', (t) => {
  const earlier = JSON.stringify({
    tool_search: { query: 'create_issue', loaded: ['create_issue'], already_loaded: [] },
    tools: [{ type: 'function', name: 'create_issue', description: 'x', parameters: {} }]
  })

  t.alike(
    resolveDeferredTools(INVENTORY, [{ role: 'tool', content: earlier }])?.toolsToRender.map(
      (item) => item.name
    ),
    ['get_weather', TOOL_SEARCH_NAME, 'create_issue'],
    'a reopened chat saved before the change declares the same tool'
  )
})

test('a loaded tool is declared in the prompt', (t) => {
  const history = [
    { role: 'user', content: 'open an issue' },
    { role: 'assistant', content: '<call tool_search>' },
    { role: 'tool', content: executeToolSearch(INVENTORY, { query: 'create_issue' }, []) }
  ]

  t.alike([...loadedToolNames(history)], ['create_issue'])

  const resolved = resolveDeferredTools(INVENTORY, history)
  t.alike(
    resolved?.toolsToRender.map((item) => item.name),
    ['get_weather', TOOL_SEARCH_NAME, 'create_issue'],
    'the loaded tool is rendered after tool_search, so the grammar and parser both accept it'
  )
  t.absent(
    'deferLoading' in resolved!.toolsToRender[2]!,
    'registration-only fields do not reach the model'
  )
})

test('loaded tools render in registration order, not load order', (t) => {
  const first = executeToolSearch(INVENTORY, { query: 'list_prs' }, [])
  const history = [
    { role: 'user', content: 'list prs, then open an issue' },
    { role: 'assistant', content: '<call tool_search>' },
    { role: 'tool', content: first },
    { role: 'assistant', content: '<call tool_search>' },
    {
      role: 'tool',
      content: executeToolSearch(INVENTORY, { query: 'create_issue' }, [
        { role: 'tool', content: first }
      ])
    }
  ]

  t.alike(
    resolveDeferredTools(INVENTORY, history)?.toolsToRender.map((item) => item.name),
    ['get_weather', TOOL_SEARCH_NAME, 'create_issue', 'list_prs'],
    'the block is the same for the same loaded set, whatever order the searches ran in'
  )
})

// The addon rejects a prompt that declares a tool it cannot select (an empty
// name or a `tool_choice` mode word) or two tools whose names fold to one
// grammar rule (fabric turns every run outside [A-Za-z0-9-] into '-').
const CLASHING: Tool[] = [
  tool('search', 'Search the web'),
  tool('search', 'Search the issue tracker', { deferLoading: true }),
  tool('search-web', 'Search the web again', { deferLoading: true }),
  tool('get-weather', 'Weather forecast', { deferLoading: true }),
  tool('get_weather', 'Weather now'),
  tool('tool-search', 'Search the docs', { deferLoading: true }),
  tool('read.file', 'Read a file', { deferLoading: true }),
  tool('read_file', 'Read a file again', { deferLoading: true }),
  tool('none', 'Do nothing', { deferLoading: true }),
  tool('', 'No name', { deferLoading: true }),
  tool('list-prs', 'List pull requests', { deferLoading: true })
]
const UNDECLARABLE = ['search', 'get-weather', 'tool-search', 'read_file', 'none', '']

test('a deferred tool the prompt could not declare is never offered', (t) => {
  const resolved = resolveDeferredTools(CLASHING, [])
  t.alike(
    resolved?.deferred.map((item) => item.name),
    ['search-web', 'read.file', 'list-prs'],
    'the first registration of each grammar rule, after the always-loaded tools and tool_search'
  )
  const catalog = buildCatalog(resolved!.deferred)
  for (const name of [
    'Search the issue tracker',
    'Weather forecast',
    'Search the docs',
    'Read a file again',
    'Do nothing',
    'No name'
  ]) {
    t.absent(catalog.includes(name), `the catalog does not list "${name}"`)
  }

  const reported = ['search', 'weather', 'docs', 'file', 'none', 'name', 'list'].flatMap(
    (query) => {
      const result = JSON.parse(executeToolSearch(CLASHING, { query }, [])) as {
        tool_search: { loaded: string[]; already_loaded: string[] }
      }
      return [...result.tool_search.loaded, ...result.tool_search.already_loaded]
    }
  )
  t.ok(
    reported.includes('read.file') && reported.includes('list-prs'),
    'declarable tools are found'
  )
  t.absent(
    reported.some((name) => UNDECLARABLE.includes(name)),
    'no search reports a tool the prompt could not declare'
  )
})

test('a clashing name from legacy history stays loaded but is not declared', (t) => {
  // Results naming every tool, as an older version or a hand-built history
  // could hold, in reverse registration order.
  const history = [...CLASHING].reverse().map((item) => ({
    role: 'tool',
    content: JSON.stringify({
      tool_search: { query: item.name, loaded: [item.name], already_loaded: [] }
    })
  }))

  const rendered = resolveDeferredTools(CLASHING, history)?.toolsToRender
  t.alike(
    [...loadedToolNames(history)],
    [...new Set([...CLASHING].reverse().map((item) => item.name))],
    'legacy results still contribute every loaded name'
  )
  t.alike(
    rendered?.map((item) => item.name),
    ['search', 'get_weather', TOOL_SEARCH_NAME, 'search-web', 'read.file', 'list-prs'],
    'one tool per grammar rule, and no unselectable name'
  )
  t.alike(
    rendered?.filter((item) => item.name !== TOOL_SEARCH_NAME).map((item) => item.description),
    ['Search the web', 'Weather now', 'Search the web again', 'Read a file', 'List pull requests'],
    'an always-loaded tool keeps its rule; among deferred tools the first registered does'
  )
})

test('loading the same tool twice reports it as already loaded', (t) => {
  const first = executeToolSearch(INVENTORY, { query: 'create_issue' }, [])
  const history = [{ role: 'tool', content: first }]

  const second = JSON.parse(executeToolSearch(INVENTORY, { query: 'create_issue' }, history)) as {
    tool_search: { loaded: string[]; already_loaded: string[] }
  }

  t.alike(second.tool_search.loaded, [], 'nothing is loaded twice')
  t.alike(second.tool_search.already_loaded, ['create_issue'], 'the model is told it can call it')
  t.alike(
    resolveDeferredTools(INVENTORY, [
      ...history,
      { role: 'tool', content: JSON.stringify(second) }
    ])?.toolsToRender.map((item) => item.name),
    ['get_weather', TOOL_SEARCH_NAME, 'create_issue'],
    'and it is declared once'
  )
})

test('a reopened conversation resolves the same loaded set', (t) => {
  const history = [
    { role: 'user', content: 'open an issue' },
    { role: 'tool', content: executeToolSearch(INVENTORY, { query: 'repository' }, []) },
    { role: 'user', content: 'now read a file' },
    { role: 'tool', content: executeToolSearch(INVENTORY, { query: 'read_file' }, []) }
  ]
  t.alike([...loadedToolNames(history)].sort(), ['create_issue', 'list_prs', 'read_file'])
})

test('tool results that are not ours are ignored', (t) => {
  const history = [
    { role: 'tool', content: 'plain text, not JSON' },
    { role: 'tool', content: '{"temp": 22}' },
    { role: 'tool', content: '{"tool_search": "not an object"}' },
    { role: 'tool', content: '{"tool_search": {"loaded": "not an array"}}' },
    { role: 'user', content: '{"tool_search":{"loaded":["spoofed"]}}' }
  ]
  t.alike([...loadedToolNames(history)], [], 'only our own tool messages count')
})

test('the same search on the same inventory is byte-identical', (t) => {
  t.is(
    executeToolSearch(INVENTORY, { query: 'repository' }, []),
    executeToolSearch(INVENTORY, { query: 'repository' }, []),
    'a repeated search cannot move the divergence point'
  )
})

test('an MCP client entry can defer every tool it exposes', async (t) => {
  const client = {
    listTools: async () => ({
      tools: [
        { name: 'create_issue', description: 'Open an issue', inputSchema: { type: 'object' } },
        { name: 'list_prs', description: 'List pull requests', inputSchema: { type: 'object' } }
      ]
    }),
    callTool: async () => ({})
  } as unknown as McpClient

  const { tools: deferred } = await getMcpToolsWithHandlers([
    { client, deferLoading: true, group: 'github' }
  ])
  t.ok(deferred.every((entry) => entry.deferLoading === true && entry.group === 'github'))

  const { tools: plain } = await getMcpToolsWithHandlers([{ client }])
  t.ok(plain.every((entry) => !('deferLoading' in entry) && !('group' in entry)))
})
