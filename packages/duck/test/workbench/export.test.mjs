import test from 'node:test'
import assert from 'node:assert/strict'
import { turns } from '../../dist/product/transcript.js'
import { toMarkdown, toHtml, lastAssistantText } from '../../dist/product/export.js'

let seq = 0
const c = (type, body = {}, runId = 'r1') => ({ seq: seq++, type, runId, ...body })
const list = turns([
  c('user-message', { userMessage: { text: 'Read <main.js> please' } }, undefined),
  c('run-request'),
  c('thinking', { thinking: { text: 'Let me look' } }),
  c('content', { content: { text: 'Reading it.' } }),
  c('tool-call', { toolCall: { name: 'read', arguments: { path: 'main.js' } } }),
  c('approval-request', { approvalRequest: { name: 'read', status: 'approved' } }),
  c('tool-result', { toolResult: { name: 'read', result: { text: "console.log('<hi>')" } } }),
  c('content', { content: { text: 'It logs `<hi>`.\n\n```js\nconsole.log(1)\n```' } }),
  c('run-status', { runStatus: { state: 'completed' } }),
  c('user-message', { userMessage: { text: 'again' } }, undefined),
  c('run-request', {}, 'r2'),
  c('tool-call', { toolCall: { name: 'bash', arguments: { cmd: 'ls' } } }, 'r2'),
  c('tool-result', { toolResult: { name: 'bash', result: { error: 'denied' } } }, 'r2'),
  c('run-status', { runStatus: { state: 'failed', reason: 'model crashed' } }, 'r2')
])
const opts = { title: 'Session', model: 'qwen3', agentName: 'QV.AC', date: '2026-10-21T00:00:00Z' }

test('toMarkdown renders turns, thinking, tools, approvals and failures', () => {
  const md = toMarkdown(list, opts)
  assert.ok(md.startsWith('# Session\n'))
  assert.match(md, /Model: qwen3/)
  assert.match(md, /## User\n\nRead <main.js> please/)
  assert.match(md, /## QV\.AC/)
  assert.match(md, /<details>\n<summary>Thinking<\/summary>\n\nLet me look/)
  assert.match(md, /Tool: read \(ok\)/)
  assert.match(md, /```json\n\{\n {2}"path": "main.js"\n\}\n```/)
  assert.match(md, /Approval:\*\* read · approved/)
  assert.match(md, /Tool: bash \(failed\)/)
  assert.match(md, /Run failed · model crashed/)
  assert.ok(
    md.indexOf('Reading it.') < md.indexOf('Tool: read') &&
      md.indexOf('Tool: read') < md.indexOf('It logs')
  )
})

test('toMarkdown uses a longer fence when a result contains backticks', () => {
  const md = toMarkdown(
    turns([
      c('tool-call', { toolCall: { name: 'x', arguments: {} } }, 'r9'),
      c('tool-result', { toolResult: { name: 'x', result: '```\ncode\n```' } }, 'r9')
    ])
  )
  assert.match(md, /````\n```\ncode\n```\n````/)
})

test('toHtml escapes content and is a themed standalone page', () => {
  const html = toHtml(list, opts)
  assert.ok(html.startsWith('<!doctype html>'))
  assert.match(html, /#08121a/)
  assert.match(html, /#2bd8bd/)
  assert.ok(html.includes('Read &lt;main.js&gt; please'))
  assert.ok(html.includes('console.log(&#39;&lt;hi&gt;&#39;)'))
  assert.ok(!html.includes('<main.js>') && !html.includes('<hi>'))
  assert.match(html, /<details><summary>Thinking<\/summary>/)
  assert.match(html, /<pre><code data-lang="js">console.log\(1\)<\/code><\/pre>/)
  assert.match(html, /class="bad">✗<\/span> <b>bash<\/b>/)
  assert.match(html, /Run failed · model crashed/)
  assert.doesNotMatch(html, /<script/i)
})

test('toHtml escapes a hostile title and neutralises unsafe source links', () => {
  const html = toHtml(
    turns([
      c('sources', { sources: { sources: [{ url: 'javascript:alert(1)', title: 'x' }] } }, 'r3')
    ]),
    { title: '</title><script>' }
  )
  assert.equal(html.includes('<script>'), false)
  assert.ok(html.includes('href="#"'))
})

test('lastAssistantText returns the final content of the last answering turn', () => {
  assert.equal(lastAssistantText(list), 'It logs `<hi>`.\n\n```js\nconsole.log(1)\n```')
  assert.equal(lastAssistantText([]), '')
})
