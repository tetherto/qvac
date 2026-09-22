import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import type { Tool, ToolCall } from '@qvac/sdk'
import {
  extractToolChoice,
  openaiToolsToSdk,
  InvalidToolChoiceError
} from '@/serve/extensions/openai/schemas/common'
import { foldToolSearch, stripToolSearchCalls } from '@/serve/lib/tool-search'

const DEFERRED_WIRE = {
  type: 'function',
  function: {
    name: 'create_issue',
    description: 'Open a new issue',
    parameters: { type: 'object', properties: { title: { type: 'string' } } },
    defer_loading: true,
    group: 'github'
  }
}

const PLAIN_WIRE = {
  type: 'function',
  function: {
    name: 'get_weather',
    description: 'Current weather',
    parameters: { type: 'object', properties: { city: { type: 'string' } } }
  }
}

describe('openaiToolsToSdk: defer_loading', () => {
  it('maps defer_loading and group off the function object', () => {
    const [tool] = openaiToolsToSdk([DEFERRED_WIRE])!
    assert.equal(tool!.deferLoading, true)
    assert.equal(tool!.group, 'github')
  })

  it('accepts them on the tool entry as well', () => {
    const [tool] = openaiToolsToSdk([
      { type: 'function', defer_loading: true, group: 'github', function: PLAIN_WIRE.function }
    ])!
    assert.equal(tool!.deferLoading, true)
    assert.equal(tool!.group, 'github')
  })

  it('leaves a tool that does not ask for it untouched', () => {
    const [tool] = openaiToolsToSdk([PLAIN_WIRE])!
    assert.equal('deferLoading' in tool!, false)
    assert.equal('group' in tool!, false)
  })
})

describe('extractToolChoice: deferred tools', () => {
  const tools = openaiToolsToSdk([DEFERRED_WIRE, PLAIN_WIRE])!

  it('rejects naming a deferred tool', () => {
    assert.throws(
      () => extractToolChoice({ tool_choice: { type: 'function', name: 'create_issue' } }, tools),
      (err: unknown) =>
        err instanceof InvalidToolChoiceError && err.message.includes('defer_loading')
    )
  })

  it('allows naming tool_search when something defers', () => {
    assert.equal(
      extractToolChoice({ tool_choice: { type: 'function', name: 'tool_search' } }, tools),
      'tool_search'
    )
  })

  it('rejects tool_search when nothing defers', () => {
    assert.throws(
      () =>
        extractToolChoice(
          { tool_choice: { type: 'function', name: 'tool_search' } },
          openaiToolsToSdk([PLAIN_WIRE])!
        ),
      InvalidToolChoiceError
    )
  })

  it('still allows naming a plain tool', () => {
    assert.equal(
      extractToolChoice({ tool_choice: { type: 'function', name: 'get_weather' } }, tools),
      'get_weather'
    )
  })
})

describe('foldToolSearch', () => {
  const tools = openaiToolsToSdk([DEFERRED_WIRE, PLAIN_WIRE])!
  const history = [{ role: 'user', content: 'open an issue' }]
  const call = (name: string): ToolCall => ({
    id: 'call-1',
    name,
    arguments: { query: 'create_issue' }
  })

  it('returns null when the turn asked for no search', () => {
    assert.equal(foldToolSearch(tools, history, [call('get_weather')], 'text'), null)
    assert.equal(foldToolSearch(tools, history, [], 'text'), null)
  })

  it('does not fold a turn that also called a tool the client must run', () => {
    // Folding would continue the loop and throw this round's `get_weather`
    // away; only the client can answer it, so the turn is returned as it
    // stands and the model searches again next request.
    const mixed = [call('tool_search'), { id: 'call-2', name: 'get_weather', arguments: {} }]
    assert.equal(foldToolSearch(tools, history, mixed, '<calls>'), null)

    const stripped = stripToolSearchCalls({
      toolCalls: mixed,
      finishReason: 'tool_calls' as const
    })
    assert.deepEqual(
      stripped.toolCalls.map((c) => c.name),
      ['get_weather'],
      'the client still gets the call it can run'
    )
  })

  it('appends the assistant turn verbatim and the search result', () => {
    const extended = foldToolSearch(tools, history, [call('tool_search')], '<call tool_search>')!
    assert.equal(extended.length, 3)
    assert.deepEqual(extended[1], { role: 'assistant', content: '<call tool_search>' })
    assert.equal(extended[2]!.role, 'tool')
    assert.ok(extended[2]!.content.includes('"create_issue"'))
    assert.ok(extended[2]!.content.includes('"title"'), 'the full schema is loaded')
  })
})

describe('tool definitions a deferred request puts in front of the model', () => {
  it('names the deferred tool without its schema', async () => {
    const { buildToolSearchTool } = await import('@qvac/sdk')
    const tools = openaiToolsToSdk([DEFERRED_WIRE, PLAIN_WIRE])! as Tool[]
    const search = buildToolSearchTool(tools.filter((tool) => tool.deferLoading === true))

    assert.ok(search.description.includes('create_issue'))
    assert.equal(search.description.includes('"title"'), false)
  })
})

describe('stripToolSearchCalls', () => {
  const call = (name: string): ToolCall => ({ id: `call-${name}`, name, arguments: {} })

  it('leaves a turn without a search untouched', () => {
    const drained = { toolCalls: [call('get_weather')], finishReason: 'tool_calls' as const }
    assert.equal(stripToolSearchCalls(drained), drained)
  })

  it('drops a search left over when the round cap ended the loop', () => {
    const stripped = stripToolSearchCalls({
      toolCalls: [call('tool_search')],
      finishReason: 'tool_calls' as const
    })
    assert.deepEqual(stripped.toolCalls, [])
    assert.equal(stripped.finishReason, 'stop', 'nothing is left for the client to run')
  })

  it('keeps the runnable calls when a turn mixes them', () => {
    const stripped = stripToolSearchCalls({
      toolCalls: [call('tool_search'), call('get_weather')],
      finishReason: 'tool_calls' as const
    })
    assert.deepEqual(
      stripped.toolCalls.map((c) => c.name),
      ['get_weather']
    )
    assert.equal(stripped.finishReason, 'tool_calls')
  })
})
