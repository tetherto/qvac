import React, { useEffect, useState } from 'react'
import { AppState, Platform, SafeAreaView, ScrollView, Text } from 'react-native'
import { activateKeepAwakeAsync } from 'expo-keep-awake'
import {
  startRpcServer,
  stopRpcServer,
  discoverRpcServers,
  getRpcDeviceMap,
  loadModel,
  completion,
  unloadModel,
  cancel,
  suspend,
  resume,
  close
} from '@qvac/sdk'
import config from './device-config.json'

type Candidate = Awaited<ReturnType<typeof discoverRpcServers>>[number]
type Task = { id: number } & (
  | { op: 'discover' | 'serve' | 'cancel' | 'suspend-resume'; topic: string; timeoutMs?: number }
  | { op: 'infer-discovered'; topic: string; minimumServers?: number }
  | { op: 'infer-explicit-control'; servers: Candidate[]; minimumServers?: number }
  | { op: 'stop'; serverId: string }
  | { op: 'close' }
)

const owned = new Set<string>()
const pause = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms))

async function execute(task: Task) {
  if (task.op === 'discover')
    return discoverRpcServers({ topic: task.topic, timeoutMs: task.timeoutMs ?? 5000 })
  if (task.op === 'serve') {
    const server = await startRpcServer({ discoveryTopic: task.topic, allowNonLoopbackHost: true })
    owned.add(server.serverId)
    return server
  }
  if (task.op === 'stop') {
    await stopRpcServer({ serverId: task.serverId })
    owned.delete(task.serverId)
    return 'stopped'
  }
  if (task.op === 'cancel') {
    const selected = discoverRpcServers({ topic: task.topic, timeoutMs: 30000 })
    const outcome = selected.then(
      () => 'completed',
      (error) => error.name
    )
    const other = discoverRpcServers({ topic: task.topic, timeoutMs: 1500 })
    await pause(100)
    await cancel({ requestId: selected.requestId })
    return { cancelled: await outcome, other: await other }
  }
  if (task.op === 'suspend-resume') {
    await suspend()
    await pause(300)
    await resume()
    return discoverRpcServers({ topic: task.topic, timeoutMs: 5000 })
  }
  if (task.op === 'infer-discovered' || task.op === 'infer-explicit-control') {
    const servers =
      task.op === 'infer-discovered'
        ? await discoverRpcServers({ topic: task.topic, timeoutMs: 5000 })
        : task.servers
    if (servers.length < (task.minimumServers ?? 1))
      throw new Error('Insufficient discovered servers')
    const devices = getRpcDeviceMap(servers).filter(
      (device) => device.totalMemory > 0 && device.freeMemory > 0
    )
    if (!devices.length) throw new Error('No RPC devices with usable memory')
    const modelId = await loadModel({
      modelSrc: `${config.coordinator}/model.gguf`,
      modelType: 'llamacpp-completion',
      modelConfig: {
        ctx_size: 512,
        predict: 16,
        device: 'gpu',
        verbosity: 2,
        'rpc-servers': servers.map((server: { url: string }) => server.url).join(','),
        devices: devices.map((device) => device.alias).join(','),
        'split-mode': 'layer',
        'tensor-split': devices.map(() => '1').join(',')
      }
    })
    try {
      const run = completion({
        modelId,
        history: [{ role: 'user', content: 'Reply with the single word hello.' }],
        generationParams: { temp: 0, seed: 1, predict: 16 },
        stream: true
      })
      let text = ''
      for await (const token of run.tokenStream) text += token
      if (!text.toLowerCase().includes('hello')) throw new Error(`Unexpected completion: ${text}`)
      return { text, servers, devices }
    } finally {
      await unloadModel({ modelId, autoClose: false })
    }
  }
  if (task.op === 'close') {
    for (const serverId of owned) await stopRpcServer({ serverId })
    owned.clear()
    await close()
    return 'closed'
  }
  throw new Error('Unknown operation')
}

export default function App() {
  const [lines, setLines] = useState<string[]>([])
  useEffect(() => {
    let running = true
    const log = (line: string) => {
      console.log(`[RPC LAN] ${line}`)
      setLines((previous) => [...previous, line].slice(-30))
    }
    void activateKeepAwakeAsync()
    const subscription = AppState.addEventListener('change', (state) => {
      log(`App state: ${state}`)
    })
    void (async () => {
      log(`${Platform.OS}; engine ${config.engine}; ${config.coordinator}`)
      while (running) {
        try {
          const response = await fetch(`${config.coordinator}/task/${Platform.OS}`)
          if (response.status === 204) {
            await pause(1000)
            continue
          }
          if (!response.ok) throw new Error(`Coordinator HTTP ${response.status}`)
          const task = (await response.json()) as Task
          log(`Starting ${task.id}: ${task.op}`)
          const started = Date.now()
          let result
          try {
            result = { ok: true, value: await execute(task) }
          } catch (error) {
            result = {
              ok: false,
              error: String(error),
              stack: error instanceof Error ? error.stack : undefined
            }
          }
          await fetch(`${config.coordinator}/result/${Platform.OS}/${task.id}`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              ...result,
              elapsedMs: Date.now() - started,
              engine: config.engine
            })
          })
          log(`${task.op}: ${JSON.stringify(result)}`)
        } catch (error) {
          log(String(error))
          await pause(2000)
        }
      }
    })()
    return () => {
      running = false
      subscription.remove()
    }
  }, [])
  return (
    <SafeAreaView style={{ flex: 1 }}>
      <ScrollView style={{ padding: 20 }}>
        <Text style={{ fontSize: 20 }}>QVAC RPC LAN validation</Text>
        <Text selectable>{lines.join('\n\n')}</Text>
      </ScrollView>
    </SafeAreaView>
  )
}
