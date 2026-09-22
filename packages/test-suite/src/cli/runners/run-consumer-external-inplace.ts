import { config as loadDotenv } from 'dotenv'
import * as os from 'node:os'
import * as path from 'node:path'
import { ConsumerBase } from '../../core/consumer-base.js'
import { BridgeExecutor } from '../../core/bridge-executor.js'
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

async function main() {
  const args = process.argv.slice(2)

  const runId = requireArg(args, 'runId')
  const name = requireArg(args, 'name')
  const configDir = path.resolve(readArg(args, 'config') ?? process.cwd())
  const mqttBrokerOverride = readArg(args, 'mqtt-broker')

  loadDotenv({ path: path.join(configDir, '.env') })

  const config = await loadConfig(configDir)
  const entry = config.consumers.external?.find((c) => c.name === name)
  if (!entry) {
    const available = (config.consumers.external ?? []).map((c) => c.name).join(', ') || 'none'
    throw new Error(`No external consumer named "${name}" (configured: ${available})`)
  }
  if (entry.mode === 'mqtt') {
    throw new Error(
      `External consumer "${name}" is configured for mqtt mode, which is declared but not ` +
        'implemented. Use mode: "bridge" until a client genuinely needs to run without Node.'
    )
  }

  console.log('📋 Loading test definitions...')
  const testDefinitions = await loadTests(config, configDir)
  console.log(`✅ Loaded ${testDefinitions.length} test definitions\n`)

  // A relative interpreter is relative to the config directory, not to
  // whatever cwd the run was started from — spawn() resolves the command
  // against the parent's cwd, not the child's, so resolve it here.
  const interpreter = entry.interpreter.includes('/')
    ? path.resolve(configDir, entry.interpreter)
    : entry.interpreter

  const executor = new BridgeExecutor({
    interpreter,
    args: entry.args,
    cwd: path.resolve(configDir, entry.cwd ?? '.'),
    env: entry.env,
    testDefinitions,
    log: (msg) => console.log(msg),
    resolveBareFrom: configDir
  })

  // Start the client before registering: a client that cannot start should
  // fail the run outright rather than fail every test one by one.
  await executor.start()
  console.log(`✅ External client "${name}" ready\n`)

  const mqttConfig = buildMqttConnectionConfig(config)
  if (mqttBrokerOverride) {
    mqttConfig.brokerUrl = mqttBrokerOverride
  }

  const consumerId = `consumer-${entry.platform}-${os.hostname()}-${Date.now()}`
  const client = createMqttClient(mqttConfig, configDir, { clientId: consumerId })

  // The sampler sums RSS across the watched process tree. The client process
  // is our child and it spawns the worker as its own child, so the tree covers
  // both. A client that re-parents or attaches to a shared worker would
  // under-count — that is a per-client check, not a free property.
  const memoryPoller = startNodeMemoryPoller({
    client,
    runId,
    consumerId,
    platform: entry.platform
  })
  if (memoryPoller) {
    console.log('📈 Memory poller enabled (publishing rss to qvac/app-memory)')
  }

  const consumer = new ConsumerBase(
    client,
    consumerId,
    entry.platform,
    runId,
    executor,
    {
      log: (msg) => console.log(msg),
      updateStats: () => {},
      onShutdown: () => {
        memoryPoller?.stop()
        executor.stop()
      }
    },
    testDefinitions
  )

  consumer.setupMqttHandlers()

  const FORCE_EXIT_TIMEOUT_MS = 10_000
  const shutdown = async () => {
    memoryPoller?.stop()
    const forceExit = setTimeout(() => process.exit(0), FORCE_EXIT_TIMEOUT_MS)
    forceExit.unref?.()
    try {
      await consumer.forceShutdown()
      executor.stop()
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error)
      console.error('⚠️  Force shutdown error:', message)
    } finally {
      clearTimeout(forceExit)
      process.exit(0)
    }
  }
  process.once('SIGINT', () => void shutdown())
  process.once('SIGTERM', () => void shutdown())
}

main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error)
  console.error('❌ Failed to start external consumer:', message)
  process.exit(1)
})
