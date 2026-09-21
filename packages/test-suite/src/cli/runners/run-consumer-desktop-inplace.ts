import { config as loadDotenv } from 'dotenv'
import * as os from 'node:os'
import * as path from 'node:path'
import { pathToFileURL } from 'node:url'
import { ConsumerBase, type TestExecutor } from '../../core/consumer-base.js'
import type { TestDefinition } from '../../types/test-definition.js'
import { startNodeMemoryPoller } from '../../core/node-memory-poller.js'
import { loadConfig } from '../../utils/config-loader.js'
import { loadTests } from '../../utils/test-loader.js'
import { buildMqttConnectionConfig, createMqttClient } from '../../utils/mqtt-connection.js'

function readArg(args: string[], name: string): string | undefined {
  const prefix = `--${name}=`
  const match = args.find((a) => a.startsWith(prefix))
  if (!match) return undefined
  return match.slice(prefix.length)
}

function requireArg(args: string[], name: string): string {
  const value = readArg(args, name)
  if (!value) {
    console.error(`❌ --${name} is required`)
    process.exit(1)
  }
  return value
}

interface ConsumerEntry {
  executor: TestExecutor
  // Mirrors ConsumerCallbacks.onBootstrap; `() => Promise<void>` user
  // bootstraps remain compatible (TS fewer-params variance)
  bootstrap?: (filteredTests?: TestDefinition[]) => Promise<void>
}

async function loadConsumerEntry(entryAbsPath: string): Promise<ConsumerEntry> {
  const entryUrl = pathToFileURL(entryAbsPath).href
  const mod = await import(entryUrl)
  const executor =
    (mod as { executor?: unknown; default?: unknown }).executor ??
    (mod as { default?: unknown }).default

  if (!executor || typeof executor !== 'object' || !('executeTest' in executor)) {
    throw new Error(
      `Consumer entry must export { executor } (or default) with executeTest(testId, context, params, expectation)`
    )
  }

  const bootstrap = typeof mod.bootstrap === 'function' ? mod.bootstrap : undefined

  return { executor: executor as TestExecutor, bootstrap }
}

async function main() {
  const args = process.argv.slice(2)

  const runId = requireArg(args, 'runId')
  const configDir = path.resolve(readArg(args, 'config') ?? process.cwd())
  const platform = readArg(args, 'platform') ?? 'desktop'
  const mqttBrokerOverride = readArg(args, 'mqtt-broker')

  // Load .env from the config directory (mocha-like behavior)
  loadDotenv({ path: path.join(configDir, '.env') })

  const config = await loadConfig(configDir)
  if (!config.consumers.desktop) {
    throw new Error('No desktop consumer configuration found')
  }

  const entryAbs = path.resolve(configDir, config.consumers.desktop.entry)
  const { executor, bootstrap } = await loadConsumerEntry(entryAbs)

  console.log('📋 Loading test definitions...')
  const testDefinitions = await loadTests(config, configDir)
  console.log(`✅ Loaded ${testDefinitions.length} test definitions\n`)

  const mqttConfig = buildMqttConnectionConfig(config)
  if (mqttBrokerOverride) {
    mqttConfig.brokerUrl = mqttBrokerOverride
  }

  const consumerId = `consumer-${platform}-${os.hostname()}-${Date.now()}`
  const client = createMqttClient(mqttConfig, configDir, { clientId: consumerId })

  if (executor.initProfiling) {
    executor.initProfiling()
    console.log('📈 Profiling enabled')
  }

  // Sample our process tree's RSS (parent + Bare worker + any other children)
  // and publish to the orchestrator over MQTT. Runs alongside ConsumerBase so
  // memory data survives a hard crash of the consumer.
  const memoryPoller = startNodeMemoryPoller({ client, runId, consumerId, platform })
  if (memoryPoller) {
    console.log('📈 Memory poller enabled (publishing rss to qvac/app-memory)')
  }

  const consumer = new ConsumerBase(
    client,
    consumerId,
    platform,
    runId,
    executor,
    {
      log: (msg) => console.log(msg),
      onBootstrap: bootstrap,
      updateStats: () => {},
      onShutdown: () => memoryPoller?.stop()
    },
    testDefinitions
  )

  consumer.setupMqttHandlers()

  // Safety net: hard-exit if forceShutdown() stalls (e.g. unreachable broker
  // blocking the awaited QoS-1 checkpoint PUBACK) so signals can't hang forever.
  const FORCE_EXIT_TIMEOUT_MS = 10_000
  const shutdown = async () => {
    memoryPoller?.stop()
    const forceExit = setTimeout(() => process.exit(0), FORCE_EXIT_TIMEOUT_MS)
    forceExit.unref?.()
    try {
      await consumer.forceShutdown()
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error)
      console.error('⚠️  Force shutdown error:', message)
    } finally {
      clearTimeout(forceExit)
      process.exit(0)
    }
  }
  // once() so double-Ctrl-C can't re-enter the async handler; catch to avoid an
  // unhandled rejection from the async signal handler.
  process.once('SIGINT', () => void shutdown())
  process.once('SIGTERM', () => void shutdown())
}

main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error)
  console.error('❌ Failed to start consumer:', message)
  process.exit(1)
})
