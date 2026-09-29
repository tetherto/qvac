// npx tsx rpc-inference.ts my-private-rpc-group
import {
  discoverRpcServers,
  getRpcDeviceMap,
  loadModel,
  completion,
  unloadModel,
  close,
  LLAMA_3_2_1B_INST_Q4_0
} from '@qvac/sdk'

try {
  const topic = process.argv[2]
  if (!topic) throw new Error('Usage: rpc-inference.ts <topic>')
  const selected = (await discoverRpcServers({ topic, timeoutMs: 5000 }))
    .sort((a, b) => a.url.localeCompare(b.url))
    .slice(0, 2)
  if (selected.length !== 2) throw new Error('Two idle RPC servers are required')
  const devices = getRpcDeviceMap(selected)
  if (!devices.length) throw new Error('The selected servers expose no devices')
  console.error(`▸ Using ${devices.length} devices across ${selected.length} servers`)
  const modelId = await loadModel({
    modelSrc: LLAMA_3_2_1B_INST_Q4_0,
    modelConfig: {
      device: 'gpu',
      'rpc-servers': selected.map((server) => server.url).join(','),
      devices: devices.map((device) => device.alias).join(','),
      'split-mode': 'layer',
      'tensor-split': devices.map(() => '1').join(',')
    },
    onProgress: (progress) => {
      process.stderr.write(`\r▸ Downloading ${progress.percentage.toFixed(0)}%`)
    }
  })
  try {
    process.stderr.write('\n')
    const run = completion({
      modelId,
      history: [{ role: 'user', content: 'Explain distributed inference in one sentence.' }],
      stream: true
    })
    for await (const token of run.tokenStream) process.stdout.write(token)
    process.stdout.write('\n')
  } finally {
    await unloadModel({ modelId })
  }
} catch (error) {
  console.error('✖', error)
  process.exitCode = 1
} finally {
  await close()
}
