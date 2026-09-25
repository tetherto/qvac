import * as os from 'node:os'
import mqtt from 'mqtt'
import {
  ConsumerBase,
  createExecutor,
  SkipExecutor,
  loadConfig,
  loadTests,
  buildMqttConnectionConfig,
  buildMqttOptions,
  logMqttConnectionSecurity,
  startNodeMemoryPoller,
  type TestDefinition
} from '@qvac/test-suite'
import { profiler } from '@qvac/sdk'
import * as fs from 'node:fs'
import * as path from 'node:path'
import { ResourceManager } from '../shared/resource-manager.js'
import { collectTestDeps } from '../shared/collect-test-deps.js'
import { ModelLoadingExecutor } from '../shared/executors/model-loading-executor.js'
import { CompletionExecutor } from '../shared/executors/completion-executor.js'
import { ToolsExecutor } from '../shared/executors/tools-executor.js'
import { TranslationExecutor } from '../shared/executors/translation-executor.js'
import { TranslationBergamotCacheExecutor } from '../shared/executors/translation-bergamot-cache-executor.js'
import { ShardedModelExecutor } from '../shared/executors/sharded-model-executor.js'
import { HttpEmbeddingExecutor } from '../shared/executors/http-embedding-executor.js'
import { KvCacheExecutor } from '../shared/executors/kv-cache-executor.js'
import { EmbeddingExecutor } from '../shared/executors/embedding-executor.js'
import { TranscriptionExecutor } from '../shared/executors/node/transcription-executor.js'
import { TranscribeStreamEventsExecutor } from '../shared/executors/node/transcribe-stream-events-executor.js'
import { RagExecutor } from '../shared/executors/node/rag-executor.js'
import { VectorIndexExecutor } from '../shared/executors/vector-index-executor.js'
import { OcrExecutor } from '../shared/executors/node/ocr-executor.js'
import { ClassificationExecutor } from '../shared/executors/node/classification-executor.js'
import { ConfigReloadExecutor } from '../shared/executors/node/config-reload-executor.js'
import { NodeLoggingExecutor } from '../shared/executors/node/logging-executor.js'
import { RegistryExecutor } from '../shared/executors/registry-executor.js'
import { ModelInfoExecutor } from '../shared/executors/model-info-executor.js'
import { WrongModelExecutor } from '../shared/executors/wrong-model-executor.js'
import { ErrorExecutor } from '../shared/executors/error-executor.js'
import { TtsExecutor } from '../shared/executors/tts-executor.js'
import { ParakeetStreamExecutor } from '../shared/executors/node/parakeet-stream-executor.js'
import { ParakeetExecutor } from '../shared/executors/node/parakeet-executor.js'
import { BciExecutor } from '../shared/executors/node/bci-executor.js'
import { VisionExecutor } from '../shared/executors/node/vision-executor.js'
import { DownloadExecutor } from '../shared/executors/download-executor.js'
import { DownloadResilienceExecutor } from '../shared/executors/node/download-resilience-executor.js'
import { LifecycleExecutor } from '../shared/executors/lifecycle-executor.js'
import { SystemResourcesExecutor } from '../shared/executors/system-resources-executor.js'
import { ConfigExecutor } from '../shared/executors/config-executor.js'
import { MultiGpuExecutor } from '../shared/executors/multi-gpu-executor.js'
import { BatchCompletionExecutor } from '../shared/executors/batch-completion-executor.js'
import { NodeCancellationExecutor } from '../shared/executors/node/cancellation-executor.js'
import { PluginExecutor } from '../shared/executors/plugin-executor.js'
import { SnapStorageExecutor } from '../shared/executors/node/snap-storage-executor.js'
import { runSnapRefreshProbe as executeSnapRefreshProbe } from './snap-refresh-probe.js'

const isSnapConsumer = process.env['QVAC_TEST_PLATFORM'] === 'snap-linux'

import * as MODEL_CONSTANTS from '@qvac/sdk'
import { RESOURCE_TABLE } from '../shared/resource-table.js'
import { applyResourceTable } from '../shared/resource-table-types.js'

/** Where the shared table's `$asset` placeholders point on this platform. */
function resolveTableAsset(kind: string, file: string): string {
  return path.resolve(process.cwd(), `assets/${kind}`, file)
}

const resources = new ResourceManager({
  downloadTarget: 'desktop'
})

// One table, shared with every other client, applied here.
//
// Which model `llm` or `tts-supertonic` means used to be written out once per
// consumer entry and nowhere a client in another language could read it. A
// definition that says `useModel: { deps: ['whisper'] }` only means the same
// thing on two clients if both resolve the key the same way, so the table is
// data now and this is the part that cannot be: the descriptor behind a model
// constant, and where a bundled fixture lives on this platform.
applyResourceTable(
  RESOURCE_TABLE,
  'electron',
  (dep, definition) => resources.define(dep, definition as never),
  (name) => (MODEL_CONSTANTS as Record<string, unknown>)[name],
  (kind, file) => resolveTableAsset(kind, file)
)

function readJsonConfig(configPath: string) {
  return JSON.parse(fs.readFileSync(configPath, 'utf8')) as Record<string, unknown>
}

function resolveElectronRuntimeDir() {
  const snapCommon = process.env['SNAP_USER_COMMON']
  return snapCommon ? path.join(snapCommon, 'qvac-test-runtime') : process.cwd()
}

function resolveBatchAttachmentPath(inputPath: string) {
  const fileName = inputPath.split('/').pop()
  if (!fileName) return inputPath
  return path.resolve(process.cwd(), 'assets/images', fileName)
}

function ensureElectronE2EConfig() {
  const configDir = process.cwd()
  const runtimeDir = resolveElectronRuntimeDir()
  const electronFixturePath = path.resolve(configDir, 'fixtures/qvac.config.electron.json')
  const e2eFixturePath = path.resolve(configDir, 'fixtures/qvac.config.e2e.json')
  const existingPath = process.env['QVAC_CONFIG_PATH']
  const electronFixtureConfig = readJsonConfig(electronFixturePath)
  const e2eFixtureConfig = readJsonConfig(e2eFixturePath)
  const existingConfig =
    existingPath && fs.existsSync(existingPath) ? readJsonConfig(existingPath) : {}
  const mergedConfig = {
    ...electronFixtureConfig,
    ...e2eFixtureConfig,
    ...existingConfig
  }
  fs.mkdirSync(runtimeDir, { recursive: true })
  const generatedPath = path.resolve(runtimeDir, 'qvac.config.e2e.generated.json')

  fs.writeFileSync(generatedPath, `${JSON.stringify(mergedConfig, null, 2)}\n`)
  process.env['QVAC_CONFIG_PATH'] = generatedPath

  if (existingPath) {
    console.log(
      `📦 Electron e2e config merged ${electronFixturePath}, ${e2eFixturePath}, and ${existingPath}; using ${generatedPath}`
    )
  } else {
    console.log(`📦 Electron e2e config set to ${generatedPath}`)
  }
}

export async function bootstrap(filteredTests?: TestDefinition[]) {
  ensureElectronE2EConfig()

  const allowedDeps = filteredTests ? collectTestDeps(filteredTests) : undefined
  await resources.downloadAllOnce(console.log, { allowedDeps })
}

export async function runSnapRefreshProbe() {
  await executeSnapRefreshProbe(ensureElectronE2EConfig)
}

const snapStorageHandler = isSnapConsumer
  ? new SnapStorageExecutor()
  : new SkipExecutor(
      /^snap-storage-/,
      'Snap storage tests require the strict-confined Snap consumer'
    )

export const executor = createExecutor({
  handlers: [
    snapStorageHandler,
    // Electron keeps the stable desktop/shared surface enabled, but excludes
    // suites that are resource-heavy or incompatible with the packaged
    // Electron worker lifecycle.
    new SkipExecutor(
      /^(diffusion-|addon-logging-diffusion$)/,
      'Electron skips diffusion tests because image generation takes too long for the stable Electron pass'
    ),
    new SkipExecutor(
      /^world-/,
      'Electron skips ABot-World: a walk session needs a dedicated GPU and the 13.3 GB model set is far beyond the stable Electron pass'
    ),
    new SkipExecutor(
      /^audio-(gen|edit|understand)-/,
      'AudioGen e2e is desktop-only: the ACE-Step stack is four GGUFs, too heavy for the stable Electron pass'
    ),
    new SkipExecutor(
      /^finetune-/,
      'Electron skips finetune tests because training operations take too long for the stable Electron pass'
    ),
    new SkipExecutor(
      /^no-lingering-bare-/,
      'Electron skips no-lingering-bare tests because they spawn and terminate standalone Bare workers outside the packaged app lifecycle'
    ),
    new SkipExecutor(
      /^worker-restart-/,
      'Electron skips the kv-cache worker-restart test because it asserts on Bare worker processes outside the packaged app lifecycle'
    ),
    new SkipExecutor(
      /^vla-/,
      'Electron skips VLA tests because VLA model execution takes too long for the stable Electron pass'
    ),
    new ModelLoadingExecutor(resources),
    new BatchCompletionExecutor(resources, {
      resolveAttachmentPath: resolveBatchAttachmentPath
    }),
    new CompletionExecutor(resources),
    new TranscriptionExecutor(resources),
    new TranscribeStreamEventsExecutor(resources),
    new EmbeddingExecutor(resources),
    new RagExecutor(resources),
    new VectorIndexExecutor(resources),
    new ModelInfoExecutor(resources),
    new WrongModelExecutor(resources),
    new ErrorExecutor(resources),
    new ToolsExecutor(resources),

    // Must precede TranslationExecutor — patterns overlap, dispatch is first-match-wins.
    new TranslationBergamotCacheExecutor(),
    new TranslationExecutor(resources),
    new ShardedModelExecutor(resources),
    new OcrExecutor(resources),
    new ClassificationExecutor(resources),
    new TtsExecutor(resources),
    new ConfigReloadExecutor(resources),
    new NodeLoggingExecutor(resources),
    new RegistryExecutor(resources),
    new HttpEmbeddingExecutor(resources),
    new KvCacheExecutor(resources),
    new ParakeetStreamExecutor(resources),
    new ParakeetExecutor(resources),
    new BciExecutor(resources),
    new VisionExecutor(resources),
    // Must precede DownloadExecutor — its /^download-/ pattern also matches
    // download-resilience-*, and dispatch is first-match-wins.
    new DownloadResilienceExecutor(),
    new DownloadExecutor(),
    new LifecycleExecutor(resources),
    new SystemResourcesExecutor(),
    new ConfigExecutor(),
    new MultiGpuExecutor(resources),
    new NodeCancellationExecutor(resources),
    new PluginExecutor(resources)
  ],
  profiling: {
    init: () => profiler.enable({ mode: 'summary', includeServerBreakdown: true }),
    exportData: () => profiler.exportJSON()
  }
})

export async function startElectronConsumer() {
  const runId = process.env['QVAC_TEST_RUN_ID']
  const configDir = process.env['QVAC_TEST_CONFIG_DIR']
  const platform = process.env['QVAC_TEST_PLATFORM'] ?? 'electron'
  const mqttBrokerOverride = process.env['QVAC_TEST_MQTT_BROKER']

  if (!runId) {
    throw new Error('QVAC_TEST_RUN_ID is required')
  }
  if (!configDir) {
    throw new Error('QVAC_TEST_CONFIG_DIR is required')
  }

  const config = await loadConfig(configDir)
  const testDefinitions = await loadTests(config, configDir)
  const mqttConfig = buildMqttConnectionConfig(config)
  if (mqttBrokerOverride) {
    mqttConfig.brokerUrl = mqttBrokerOverride
  }

  const consumerId = `consumer-${platform}-${os.hostname()}-${Date.now()}`
  const mqttOptions = buildMqttOptions(mqttConfig, configDir)
  mqttOptions.clientId = consumerId
  mqttOptions.clean = false
  mqttOptions.manualConnect = true
  logMqttConnectionSecurity(mqttConfig.brokerUrl, mqttOptions)
  const client = mqtt.connect(mqttConfig.brokerUrl, mqttOptions)

  if (executor.initProfiling) {
    executor.initProfiling()
    console.log('📈 Profiling enabled')
  }

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
  client.connect()

  const shutdown = () => {
    memoryPoller?.stop()
    consumer.forceShutdown()
  }
  process.on('SIGINT', shutdown)
  process.on('SIGTERM', shutdown)
}
