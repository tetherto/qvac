/**
 * Tool-calling example using the DSML dialect (DeepSeek Markup Language).
 *
 * DeepSeek V3.2 / V4 emit tool calls as DSML blocks, where the markup token is
 * a fullwidth vertical line (U+FF5C `｜`), not an ASCII pipe:
 *   <｜DSML｜tool_calls>
 *   <｜DSML｜invoke name="NAME">
 *   <｜DSML｜parameter name="KEY" string="true">VALUE</｜DSML｜parameter>
 *   </｜DSML｜invoke>
 *   </｜DSML｜tool_calls>
 *
 * The dialect is auto-detected when the model name/path contains "deepseek-v4"
 * or "deepseek-v3.2". This example passes toolDialect: "dsml" explicitly so it
 * also works with locally renamed weights.
 *
 * There is no DeepSeek registry constant yet, so the model source (a local
 * GGUF path or an http(s) URL — first shard for sharded weights) is required.
 *
 * Usage:
 *   bun run bare:example dist/examples/tools/llamacpp-tools-dsml.js <model-src>
 */
import { completion, loadModel, unloadModel, type ToolCall } from '@qvac/sdk'
import { tools, mockExecute } from './shared'

const modelSrc = process.argv[2]

if (!modelSrc) {
  console.error('✖ Missing model source: pass a DeepSeek V3.2 / V4 GGUF path or URL')
  process.exit(1)
}

let modelId: string | undefined
try {
  modelId = await loadModel({
    modelSrc,
    modelType: 'llamacpp-completion',
    modelConfig: { ctx_size: 4096, tools: true },
    onProgress: (p) => {
      const mb = (n: number) => (n / 1e6).toFixed(1)
      const line = `▸ Downloading ${p.percentage.toFixed(0)}% (${mb(p.downloaded)}/${mb(p.total)} MB)`
      process.stderr.write(process.stderr.isTTY ? `\r${line}` : `${line}\n`)
      if (p.percentage >= 100) process.stderr.write('\n')
    }
  })
  console.log(`▸ Model loaded: ${modelId}`)

  const history = [
    {
      role: 'system',
      content: 'You are a helpful assistant that can call tools to look up weather and horoscopes.'
    },
    {
      role: 'user',
      content: "What's the weather in Tokyo and my horoscope for Aquarius?"
    }
  ]

  const result = completion({
    modelId,
    history,
    stream: true,
    tools,
    toolDialect: 'dsml'
  })

  const tokensTask = (async () => {
    for await (const token of result.tokenStream) {
      process.stdout.write(token)
    }
  })()

  const toolsTask = (async () => {
    for await (const evt of result.toolCallStream) {
      if (evt.type === 'toolCall') {
        console.log(`\n▸ ${evt.call.name}(${JSON.stringify(evt.call.arguments)})`)
      }
    }
  })()

  await Promise.all([tokensTask, toolsTask])

  const toolCalls: ToolCall[] = await result.toolCalls

  console.log('\n\n▸ Final tool calls:')
  if (toolCalls.length > 0) {
    for (const call of toolCalls) {
      console.log(`▸ ${call.name}(${JSON.stringify(call.arguments)})`)
      const toolResult = mockExecute(call.name, call.arguments)
      console.log(`▸ result: ${toolResult}`)
    }
  } else {
    console.log('▸ (none)')
  }

  await unloadModel({ modelId, clearStorage: false })
} catch (error) {
  console.error('✖', error)
  if (modelId) await unloadModel({ modelId, clearStorage: false }).catch(() => {})
  process.exit(1)
}
