import test from 'brittle'
import { historyMessageSchema } from '@/schemas'
import { transformMessages } from '@/plugins/builtin/llamacpp-completion/ops/completion-stream'
import { generateCacheKey } from '@/plugins/ops/kv-cache-utils'

const callTurn = {
  role: 'assistant',
  content: '',
  toolCalls: [{ id: 'call_1', name: 'get_weather', arguments: { city: 'Paris' } }]
}
const resultTurn = { role: 'tool', content: '18C', toolCallId: 'call_1', toolName: 'get_weather' }

test('historyMessageSchema: accepts tool calls on assistant turns and call ids on tool turns', (t) => {
  t.ok(historyMessageSchema.safeParse(callTurn).success)
  t.ok(historyMessageSchema.safeParse(resultTurn).success)
  t.ok(historyMessageSchema.safeParse({ role: 'user', content: 'hi' }).success)
})

test('historyMessageSchema: rejects tool fields on the wrong role', (t) => {
  const cases = [
    { role: 'user', content: 'hi', toolCalls: callTurn.toolCalls },
    { role: 'assistant', content: 'x', toolCallId: 'call_1' },
    { role: 'user', content: 'x', toolName: 'get_weather' },
    { role: 'assistant', content: '', toolCalls: [{ name: '', arguments: {} }] }
  ]
  for (const message of cases) {
    t.is(historyMessageSchema.safeParse(message).success, false, JSON.stringify(message))
  }
})

test('transformMessages: forwards tool turns in the addon message shape', (t) => {
  t.alike(transformMessages([callTurn, resultTurn]), [
    {
      role: 'assistant',
      content: '',
      tool_calls: [{ id: 'call_1', name: 'get_weather', arguments: { city: 'Paris' } }]
    },
    { role: 'tool', content: '18C', tool_call_id: 'call_1', name: 'get_weather' }
  ])
})

test('transformMessages: plain messages keep their shape', (t) => {
  t.alike(transformMessages([{ role: 'user', content: 'hi' }]), [{ role: 'user', content: 'hi' }])
})

test('generateCacheKey: tool turns with equal content but different calls get different keys', (t) => {
  const other = { ...resultTurn, toolCallId: 'call_2' }
  t.not(generateCacheKey([resultTurn]), generateCacheKey([other]))
  t.is(
    generateCacheKey([{ role: 'user', content: 'hi' }]),
    generateCacheKey([{ role: 'user', content: 'hi', attachments: undefined }]),
    'a plain message keys as before'
  )
})
