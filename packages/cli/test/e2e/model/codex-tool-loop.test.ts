import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { useModelServer } from '../helpers/server.js'
import { collectSSE } from '../helpers/http.js'

// Qwen3.5's chat template rejects `developer` turns and any system turn that is
// not first, which is the case these requests exercise. Qwen3's template does
// not, so the shared real-model config cannot catch a regression here.
const CODEX_LLM = 'codex-llm'
const server = useModelServer({
  serve: {
    models: {
      [CODEX_LLM]: {
        model: 'QWEN3_5_0_8B_MULTIMODAL_Q4_K_M',
        preload: true,
        config: { ctx_size: 4096, tools: true }
      }
    }
  }
})

const shellTool = {
  type: 'function',
  name: 'shell',
  description: 'Run a shell command and return its output.',
  parameters: {
    type: 'object',
    properties: { command: { type: 'array', items: { type: 'string' } } },
    required: ['command']
  }
}

function message(role: string, text: string) {
  return { type: 'message', role, content: [{ type: 'input_text', text }] }
}

const developer = message(
  'developer',
  'Use the shell tool to run commands. Never print commands for the user to run.'
)
const question = message('user', 'What is the project name in package.json? Read the file.')

function responses(body: Record<string, unknown>) {
  return server().inject({
    method: 'POST',
    url: '/v1/responses',
    payload: {
      model: CODEX_LLM,
      instructions: 'You are a coding agent.',
      tools: [shellTool],
      store: false,
      reasoning_budget: false,
      max_output_tokens: 256,
      temperature: 0,
      seed: 1,
      ...body
    }
  })
}

function functionCalls(response: any): any[] {
  return (response.output ?? []).filter((item: any) => item.type === 'function_call')
}

describe('responses: Codex tool loop', () => {
  for (const [name, input] of [
    ['a leading developer message', [developer, question]],
    ['an interleaved developer message', [question, developer, question]]
  ] as const) {
    it(`calls the tool with ${name} and tool_choice required`, async () => {
      const res = await responses({ input, tool_choice: 'required' })
      assert.equal(res.statusCode, 200, res.body)
      const body = res.json() as any
      assert.equal(body.status, 'requires_action')
      assert.equal(functionCalls(body)[0]?.name, 'shell')
    })
  }

  it('streams the tool call with a developer message', async () => {
    const res = await responses({
      input: [developer, question],
      tool_choice: 'required',
      stream: true
    })
    assert.equal(res.statusCode, 200)
    const completed = collectSSE(res.body).find(
      (e) => (e.data as any)?.type === 'response.completed'
    )
    assert.ok(completed, 'stream ended with response.completed')
    assert.equal(functionCalls((completed.data as any).response)[0]?.name, 'shell')
  })

  it('answers from the tool result on the next turn', async () => {
    const first = (
      await responses({ input: [developer, question], tool_choice: 'required' })
    ).json() as any
    const call = functionCalls(first)[0]
    assert.ok(call, 'first turn requested a tool call')

    const res = await responses({
      input: [
        developer,
        question,
        {
          type: 'function_call',
          call_id: call.call_id,
          name: call.name,
          arguments: call.arguments
        },
        {
          type: 'function_call_output',
          call_id: call.call_id,
          output: '{\n  "name": "acme-widgets",\n  "version": "1.2.0"\n}'
        }
      ]
    })
    assert.equal(res.statusCode, 200, res.body)
    const body = res.json() as any
    assert.equal(body.status, 'completed')
    assert.match(body.output_text, /acme-widgets/)
  })
})

describe('responses: Codex tool shapes', () => {
  // Codex groups MCP tools in `namespace` tools and adds built-ins like web_search.
  const codexTools = [
    { type: 'web_search', external_web_access: false },
    {
      type: 'namespace',
      name: 'mcp__files',
      description: 'Workspace files.',
      tools: [
        {
          type: 'function',
          name: 'read_file',
          description: 'Read a file and return its contents.',
          parameters: {
            type: 'object',
            properties: { path: { type: 'string' } },
            required: ['path']
          }
        }
      ]
    }
  ]

  it('calls a namespaced tool and answers from its result', async () => {
    const first = await responses({
      input: [developer, question],
      tools: codexTools,
      tool_choice: 'required'
    })
    assert.equal(first.statusCode, 200, first.body)
    const call = functionCalls(first.json())[0]
    assert.equal(call?.name, 'read_file')
    assert.equal(call?.namespace, 'mcp__files')

    const res = await responses({
      input: [
        developer,
        question,
        {
          type: 'function_call',
          call_id: call.call_id,
          namespace: call.namespace,
          name: call.name,
          arguments: call.arguments
        },
        {
          type: 'function_call_output',
          call_id: call.call_id,
          output: '{\n  "name": "acme-widgets",\n  "version": "1.2.0"\n}'
        }
      ],
      tools: codexTools
    })
    assert.equal(res.statusCode, 200, res.body)
    const body = res.json() as any
    assert.equal(body.status, 'completed')
    assert.match(body.output_text, /acme-widgets/)
  })
})

describe('chat completions: developer messages', () => {
  it('keeps tools available with a developer message', async () => {
    const res = await server().inject({
      method: 'POST',
      url: '/v1/chat/completions',
      payload: {
        model: CODEX_LLM,
        messages: [
          { role: 'system', content: 'You are a coding agent.' },
          { role: 'developer', content: 'Use the shell tool to run commands.' },
          { role: 'user', content: 'What is the project name in package.json? Read the file.' }
        ],
        tools: [
          {
            type: 'function',
            function: {
              name: shellTool.name,
              description: shellTool.description,
              parameters: shellTool.parameters
            }
          }
        ],
        tool_choice: 'required',
        reasoning_budget: false,
        max_tokens: 256,
        temperature: 0,
        seed: 1
      }
    })
    assert.equal(res.statusCode, 200, res.body)
    const message = (res.json() as any).choices[0].message
    assert.equal(message.tool_calls?.[0]?.function.name, 'shell')
  })
})
