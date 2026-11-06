import React, { useEffect, useState } from 'react'
import { AppState, Platform, SafeAreaView, ScrollView, Text } from 'react-native'
import * as Device from 'expo-device'
import { activateKeepAwakeAsync } from 'expo-keep-awake'
import {
  startRpcServer,
  stopRpcServer,
  discoverRpcServers,
  rpcServerStatusStream,
  subscribeServerLogs,
  getRpcDeviceMap,
  loadModel,
  completion,
  unloadModel,
  cancel,
  InferenceCancelledError,
  suspend,
  resume,
  state,
  close
} from '@qvac/sdk'
import { createLifecycleCoordinator, type LifecycleCoordinator } from './lifecycle-coordinator.mjs'
import config from './device-config.json'
import { describeError } from './diagnostics.mjs'

type Candidate = Awaited<ReturnType<typeof discoverRpcServers>>[number]
type NetworkSelection = { lanAddresses?: string[]; host?: string }
type Task = { id: number } & (
  | ({ op: 'discover' | 'cancel'; topic: string; timeoutMs?: number } & NetworkSelection)
  | ({ op: 'serve'; topic: string } & NetworkSelection)
  | ({ op: 'suspend-resume'; topic: string; timeoutMs?: number } & NetworkSelection)
  | ({ op: 'restart'; serverId: string; topic: string } & NetworkSelection)
  | ({
      op: 'infer-discovered'
      topic: string
      minimumServers?: number
      modelSrc?: string
    } & NetworkSelection)
  | {
      op: 'infer-explicit-control'
      servers: Candidate[]
      minimumServers?: number
      modelSrc?: string
    }
  | { op: 'stop'; serverId: string }
  | { op: 'close' }
)
type NativeLog = { at: number; id: string; namespace: string; level: string; message: string }

const pause = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms))

async function execute(
  task: Exclude<Task, { op: 'close' | 'suspend-resume' }>,
  lifecycle: LifecycleCoordinator,
  owned: Set<string>,
  nativeLogs: NativeLog[]
) {
  const call = <T,>(work: () => Promise<T>) => lifecycle.run(work)
  const lanAddresses =
    'topic' in task ? (task.lanAddresses ?? config.lanAddresses ?? undefined) : undefined
  if (task.op === 'discover')
    return call(() =>
      discoverRpcServers({ topic: task.topic, timeoutMs: task.timeoutMs ?? 5000, lanAddresses })
    )
  if (task.op === 'serve' || task.op === 'restart') {
    if (task.op === 'restart') {
      await call(() => stopRpcServer({ serverId: task.serverId }))
      owned.delete(task.serverId)
    }
    const server = await call(() =>
      startRpcServer({
        discoveryTopic: task.topic,
        allowNonLoopbackHost: true,
        host: task.host ?? config.host ?? undefined,
        lanAddresses
      })
    )
    owned.add(server.serverId)
    return server
  }
  if (task.op === 'stop') {
    await call(() => stopRpcServer({ serverId: task.serverId }))
    owned.delete(task.serverId)
    return 'stopped'
  }
  if (task.op === 'cancel') {
    const searches = await call(async () => {
      const selected = discoverRpcServers({ topic: task.topic, timeoutMs: 30000, lanAddresses })
      const other = discoverRpcServers({ topic: task.topic, timeoutMs: 1500, lanAddresses })
      return {
        selected,
        other,
        outcome: selected.then(
          () => undefined,
          (error: unknown) => error
        ),
        settled: Promise.allSettled([selected, other])
      }
    })
    try {
      await pause(100)
      await call(() => cancel({ requestId: searches.selected.requestId }))
      const outcome = await searches.outcome
      if (!(outcome instanceof InferenceCancelledError))
        throw new Error('Expected typed discovery cancellation')
      return { cancelled: outcome.name, other: await searches.other }
    } finally {
      if (!lifecycle.closing) {
        await call(() =>
          Promise.all(
            [searches.selected, searches.other].map(({ requestId }) => cancel({ requestId }))
          )
        )
      }
      await searches.settled
    }
  }
  if (task.op === 'infer-discovered' || task.op === 'infer-explicit-control') {
    const started = Date.now()
    const servers =
      task.op === 'infer-discovered'
        ? await call(() => discoverRpcServers({ topic: task.topic, timeoutMs: 5000, lanAddresses }))
        : task.servers
    if (servers.length < (task.minimumServers ?? 1))
      throw new Error('Insufficient discovered servers')
    const devices = getRpcDeviceMap(servers).filter(
      (device) => device.totalMemory > 0 && device.freeMemory > 0
    )
    if (!devices.length) throw new Error('No RPC devices with usable memory')
    const modelSrc = task.modelSrc ?? config.modelSrc
    const modelId = await call(() =>
      loadModel({
        modelSrc,
        modelType: 'llamacpp-completion',
        modelConfig: {
          ctx_size: 512,
          predict: 16,
          device: 'gpu',
          verbosity: 2,
          'rpc-servers': servers.map(({ url }) => url).join(','),
          devices: devices.map(({ alias }) => alias).join(','),
          'split-mode': 'layer',
          'tensor-split': devices.map(() => '1').join(',')
        }
      })
    )
    try {
      const run = await call(async () =>
        completion({
          modelId,
          history: [{ role: 'user', content: 'Reply with the single word hello.' }],
          generationParams: { temp: 0, seed: 1, predict: 16 },
          stream: true
        })
      )
      let text = ''
      for await (const token of run.tokenStream) text += token
      if (!text.toLowerCase().includes('hello')) throw new Error(`Unexpected completion: ${text}`)
      return {
        text,
        servers,
        devices,
        modelSrc,
        executionEvidence: {
          status: 'pending-external-verification',
          required:
            'Native server graph or tensor execution records tied to the selected endpoints',
          nativeLogs: nativeLogs.filter(({ at }) => at >= started)
        }
      }
    } finally {
      if (!lifecycle.closing) await call(() => unloadModel({ modelId, autoClose: false }))
    }
  }
  throw new Error('Unknown operation')
}

export default function App() {
  const [lines, setLines] = useState<string[]>([])
  useEffect(() => {
    let running = true
    const owned = new Set<string>()
    const nativeLogs: NativeLog[] = []
    const health: object[] = []
    const transitions: object[] = []
    const statusController = new AbortController()
    let unsubscribeLogs: (() => void) | undefined
    const metadata = {
      ...config.metadata,
      deviceModel: Device.modelName,
      osName: Device.osName,
      osVersion: Device.osVersion,
      platform: Platform.OS,
      modelSrc: config.modelSrc,
      networkSelection: { host: config.host, lanAddresses: config.lanAddresses }
    }
    const log = (line: string) => {
      console.log(`[RPC LAN] ${line}`)
      if (running) setLines((previous) => [...previous, line.slice(0, 2048)].slice(-30))
    }
    const lifecycle = createLifecycleCoordinator({
      suspend,
      resume,
      state,
      async close() {
        await close()
        owned.clear()
      },
      ontransition(transition) {
        transitions.push(transition)
        if (transitions.length > 32) transitions.shift()
        log(`Lifecycle ${JSON.stringify(transition)}`)
      }
    })
    const cleanup = async () => {
      statusController.abort()
      unsubscribeLogs?.()
    }
    const changeState = (appState: string) => {
      log(`App state: ${appState}`)
      try {
        void lifecycle
          .setForeground(appState === 'active')
          .catch((error: unknown) => log(`Lifecycle failed: ${String(error)}`))
      } catch (error) {
        if (!lifecycle.closing) log(String(error))
      }
    }
    void activateKeepAwakeAsync()
    const subscription = AppState.addEventListener('change', changeState)
    void (async () => {
      log(`Run ${JSON.stringify(metadata)}`)
      await lifecycle.setForeground(AppState.currentState === 'active')
      await lifecycle.run(async () => {
        unsubscribeLogs = subscribeServerLogs((record) => {
          const captured = {
            at: Date.now(),
            id: record.id.slice(0, 128),
            namespace: record.namespace.slice(0, 128),
            level: record.level,
            message: record.message.slice(0, 1024)
          }
          nativeLogs.push(captured)
          if (nativeLogs.length > 64) nativeLogs.shift()
          console.log(`[RPC native] ${JSON.stringify(captured)}`)
        })
        void (async () => {
          for await (const status of rpcServerStatusStream(
            {},
            { signal: statusController.signal }
          )) {
            const captured = {
              ...status,
              reason: status.reason.slice(0, 512),
              error: status.error && describeError(status.error),
              at: Date.now()
            }
            health.push(captured)
            if (health.length > 16) health.shift()
            log(`Server health ${JSON.stringify(captured)}`)
          }
        })().catch((error: unknown) => {
          if (!lifecycle.closing) log(`Health stream failed: ${String(error)}`)
        })
      })
      while (running && !lifecycle.closing) {
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
            let value
            if (task.op === 'close') {
              await lifecycle.close(cleanup)
              value = 'closed'
            } else if (task.op === 'suspend-resume') {
              await lifecycle.suspend()
              await pause(300)
              await lifecycle.resume()
              value = await execute({ ...task, op: 'discover' }, lifecycle, owned, nativeLogs)
            } else {
              value = await execute(task, lifecycle, owned, nativeLogs)
            }
            result = { ok: true, value }
          } catch (error) {
            result = { ok: false, error: describeError(error) }
          }
          await fetch(`${config.coordinator}/result/${Platform.OS}/${task.id}`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              ...result,
              elapsedMs: Date.now() - started,
              metadata,
              health,
              transitions,
              task: {
                id: task.id,
                op: task.op,
                ...('topic' in task && {
                  topic: task.topic,
                  host: task.host,
                  lanAddresses: task.lanAddresses
                })
              }
            })
          })
          log(`${task.op}: ${JSON.stringify(result)}`)
        } catch (error) {
          log(String(error))
          await pause(2000)
        }
      }
    })().catch((error: unknown) => log(`Fixture failed: ${String(error)}`))
    return () => {
      running = false
      subscription.remove()
      void lifecycle
        .close(cleanup)
        .catch((error: unknown) => log(`Teardown failed: ${String(error)}`))
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
