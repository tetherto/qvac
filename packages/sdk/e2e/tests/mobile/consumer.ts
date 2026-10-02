import { RpcServerExecutor } from '../shared/executors/rpc-server-executor.js'
import { Platform } from 'react-native'
import { createExecutor } from '@qvac/test-suite/mobile'
import type { TestDefinition } from '@qvac/test-suite'
import { profiler } from '@qvac/sdk'
import { ResourceManager } from '../shared/resource-manager.js'
import { collectTestDeps } from '../shared/collect-test-deps.js'
import { resolveBundledAssetUri } from './asset-uri.js'
import { BatchCompletionExecutor } from '../shared/executors/batch-completion-executor.js'
import { ModelLoadingExecutor } from '../shared/executors/model-loading-executor.js'
import { CompletionExecutor } from '../shared/executors/completion-executor.js'
import { EmbeddingExecutor } from '../shared/executors/embedding-executor.js'
import { ToolsExecutor } from '../shared/executors/tools-executor.js'
import { DeferredToolsExecutor } from '../shared/executors/deferred-tools-executor.js'
import { TranslationExecutor } from '../shared/executors/translation-executor.js'
import { ShardedModelExecutor } from '../shared/executors/sharded-model-executor.js'
import { HttpEmbeddingExecutor } from '../shared/executors/http-embedding-executor.js'
import { KvCacheExecutor } from '../shared/executors/kv-cache-executor.js'
import { MobileLoggingExecutor } from './executors/logging-executor.js'
import { RegistryExecutor } from '../shared/executors/registry-executor.js'
import { ModelInfoExecutor } from '../shared/executors/model-info-executor.js'
import { WrongModelExecutor } from '../shared/executors/wrong-model-executor.js'
import { ErrorExecutor } from '../shared/executors/error-executor.js'
import { MobileTranscriptionExecutor } from './executors/transcription-executor.js'
import { MobileTranscribeStreamEventsExecutor } from './executors/transcribe-stream-events-executor.js'
import { MobileParakeetStreamExecutor } from './executors/parakeet-stream-executor.js'
import { MobileParakeetExecutor } from './executors/parakeet-executor.js'
import { MobileVisionExecutor } from './executors/vision-executor.js'
import { MobileOcrExecutor } from './executors/ocr-executor.js'
import { VlaExecutor } from '../shared/executors/vla-executor.js'
import { MobileClassificationExecutor } from './executors/classification-executor.js'
import { MobileRagExecutor } from './executors/rag-executor.js'
import { VectorIndexExecutor } from '../shared/executors/vector-index-executor.js'
import { MobileConfigReloadExecutor } from './executors/config-reload-executor.js'
import { MobileTtsExecutor } from './executors/tts-executor.js'
import { DownloadExecutor } from '../shared/executors/download-executor.js'
import { MobileDownloadResilienceExecutor } from './executors/download-resilience-executor.js'
import { LifecycleExecutor } from '../shared/executors/lifecycle-executor.js'
import { SystemResourcesExecutor } from '../shared/executors/system-resources-executor.js'
import { ConfigExecutor } from '../shared/executors/config-executor.js'
import { MobileCancellationExecutor } from './executors/cancellation-executor.js'
import { PluginExecutor } from '../shared/executors/plugin-executor.js'

import * as MODEL_CONSTANTS from '@qvac/sdk'
import { RESOURCE_TABLE } from '../shared/resource-table.js'
import { applyResourceTable } from '../shared/resource-table-types.js'
import { policyFor } from '../shared/platform-policy.js'

/** Where the shared table's `$asset` placeholders point on this platform. */
async function resolveTableAsset(kind: string, file: string): Promise<string> {
  // @ts-ignore - assets.ts is generated at consumer build time, three levels
  // up from dist/tests/mobile/.
  const assets = await import('../../../assets')
  const registry = (assets as Record<string, Record<string, number> | undefined>)[kind]
  const assetModule = registry?.[file]
  if (assetModule === undefined) {
    throw new Error(`bundled asset not in registry: ${kind}/${file}`)
  }
  return await resolveBundledAssetUri(assetModule)
}

/**
 * Every `$packageAsset` the table names, written out statically. Metro resolves
 * `require` while it bundles, so a template literal fails the whole build.
 */
const PACKAGE_ASSETS: Record<string, number> = {
  // @ts-ignore - Metro turns the bundled data file into an asset module.
  '@qvac/classification-ggml/weights/mobilenetv3_3class_v3_fp16.gguf': require('../../../node_modules/@qvac/classification-ggml/weights/mobilenetv3_3class_v3_fp16.gguf')
}

/** A data file inside an installed package, as a bundled-asset URI. */
async function resolveTablePackageAsset(pkg: string, file: string): Promise<string> {
  const assetModule = PACKAGE_ASSETS[`${pkg}/${file}`]
  if (assetModule === undefined) {
    throw new Error(
      `package asset not bundled on mobile: ${pkg}/${file} -- ` +
        'add it to PACKAGE_ASSETS in tests/mobile/consumer.ts'
    )
  }
  return await resolveBundledAssetUri(assetModule)
}

// Download plan and the unload settling mobile needs -- and why it needs it -- come from the shared
// platform policy; see tests/shared/platform-policy.ts.
const resources = new ResourceManager(policyFor('mobile'))

// One table, shared with every other client, applied here.
applyResourceTable(RESOURCE_TABLE, 'mobile', (dep, definition) => resources.define(dep, definition as never), {
  const: (name) => (MODEL_CONSTANTS as Record<string, unknown>)[name],
  asset: (kind, file) => resolveTableAsset(kind, file),
  packageAsset: (pkg, file) => resolveTablePackageAsset(pkg, file)
})
// NOTE: no "vla-pi05" resource on mobile by design — the pi05 q_aggressive
// GGUF is 3.9 GB, which exceeds the iOS jetsam per-process limit (~3 GB →
// OOM kill) and is deferred on Android Device Farm until a CDN-fronted
// mirror exists. The pi05 e2e tests are skipped on mobile by the catalog;
// defining the resource here would make `downloadAllOnce` pre-fetch the
// 3.9 GB model even though the tests never run. Desktop covers pi05.

// The download-resilience HTTP test reaches flaky-lan-server.mjs on the desktop,
// which is the same machine as the MQTT broker. consumer-config.ts is generated
// at the app root at build time (3 levels up from dist/tests/mobile/, like
// assets.ts) and carries the resolved broker host. It is absent in the source
// tree, so resolve it lazily and tolerate its absence (desktop/electron builds).
function resolveBakedMqttHost(): string | undefined {
  try {
    // @ts-ignore - generated at mobile build time, not present in the source tree
    const cfg = require('../../../consumer-config')
    const host = cfg?.config?.mqtt?.host
    return typeof host === 'string' && host.length > 0 ? host : undefined
  } catch {
    return undefined
  }
}

// A download-resilience-only run needs a short registryStreamTimeoutMs so
// registry-suspend forces a stream timeout → retry → reconnect (the fix path).
// Mobile P2P block latency is far higher than desktop, so it uses its own
// fixture with a forgiving 8s timeout (vs desktop's 1s); the executor's suspend
// window is set well above it so the reconnect still reliably triggers. Any
// broader run keeps the default config, since a short timeout breaks normal
// model downloads.
function isResilienceOnlyRun(filteredTests?: TestDefinition[]): boolean {
  return (
    !!filteredTests &&
    filteredTests.length > 0 &&
    filteredTests.every((t) => t.testId.startsWith('download-resilience-'))
  )
}

async function ensureMobileE2EConfig(useResilienceConfig: boolean) {
  const env = typeof process !== 'undefined' ? process.env : undefined
  if (env?.['QVAC_CONFIG_PATH']) {
    console.log(
      `📦 Mobile e2e config: QVAC_CONFIG_PATH already set to ${env['QVAC_CONFIG_PATH']}, skipping write`
    )
    return
  }

  const fixtureName = useResilienceConfig
    ? 'qvac.config.e2e.resilience.mobile.json'
    : 'qvac.config.e2e.json'

  // @ts-ignore - assets.ts generated at consumer build time (consumer root, 3 levels up from dist/tests/mobile/)
  const assets = await import('../../../assets')
  const qvacE2EConfig = assets.other?.[fixtureName]
  if (!qvacE2EConfig || typeof qvacE2EConfig !== 'object') {
    throw new Error(
      `${fixtureName} fixture not found in mobile assets — ensure ./fixtures/**/* is listed in qvac-test.config.js mobile.assets.patterns`
    )
  }

  // @ts-ignore - expo-file-system is a peer dependency available in mobile context
  const { File, Paths } = await import('expo-file-system')
  const configFile = new File(Paths.document, 'qvac.config.json')
  if (!configFile.exists) {
    configFile.create()
  }
  await configFile.write(`${JSON.stringify(qvacE2EConfig, null, 2)}\n`)
  const cfg = qvacE2EConfig as Record<string, unknown>
  console.log(
    `📦 Mobile e2e config written to ${configFile.uri} from ${fixtureName} ` +
      `(registryStreamTimeoutMs=${cfg['registryStreamTimeoutMs']}, registryDownloadMaxRetries=${cfg['registryDownloadMaxRetries']})`
  )
}

let batchImageAssets: Record<string, number> | null = null

async function loadBatchImageAssets() {
  if (!batchImageAssets) {
    // @ts-ignore - assets.ts is generated at consumer build time
    const assets = await import('../../../assets')
    batchImageAssets = assets.images
  }
  return batchImageAssets
}

async function resolveBatchAttachmentPath(inputPath: string) {
  const images = await loadBatchImageAssets()
  const fileName = inputPath.split('/').pop()
  if (!fileName) return inputPath
  const assetModule = images?.[fileName]
  if (!assetModule) {
    throw new Error(`Image file not found in assets: ${fileName}`)
  }
  return await resolveBundledAssetUri(assetModule)
}

export async function bootstrap(filteredTests?: TestDefinition[]) {
  await ensureMobileE2EConfig(isResilienceOnlyRun(filteredTests))

  // `filteredTests` (when present) is the producer's post-filter test list
  // delivered via register-ack; absence keeps the legacy "warm everything" path.
  const allowedDeps = filteredTests ? collectTestDeps(filteredTests) : undefined
  await resources.downloadAllOnce(console.log, { allowedDeps })
}

export const executor = createExecutor({
  handlers: [
    // Mobile platform policy -- which suites are off, and on which OS -- is declared in the catalog
    // now; see tests/platform-skips.ts.

    // Real executors
    new ModelLoadingExecutor(resources),
    new BatchCompletionExecutor(resources, {
      resolveAttachmentPath: resolveBatchAttachmentPath
    }),
    new CompletionExecutor(resources),
    new MobileTranscriptionExecutor(resources),
    new MobileTranscribeStreamEventsExecutor(resources),
    new EmbeddingExecutor(resources),
    new MobileRagExecutor(resources),
    new VectorIndexExecutor(resources),
    new ModelInfoExecutor(resources),
    new WrongModelExecutor(resources),
    new ErrorExecutor(resources),
    new ToolsExecutor(resources),
    new DeferredToolsExecutor(resources),
    new TranslationExecutor(resources),
    new ShardedModelExecutor(resources),
    new MobileOcrExecutor(resources),
    new VlaExecutor(resources),
    new MobileClassificationExecutor(resources),
    new MobileTtsExecutor(resources),
    new MobileConfigReloadExecutor(resources),
    new MobileLoggingExecutor(resources),
    new RegistryExecutor(resources),
    new HttpEmbeddingExecutor(resources),
    new KvCacheExecutor(resources),
    new MobileParakeetStreamExecutor(resources),
    new MobileParakeetExecutor(resources),
    new MobileVisionExecutor(resources),
    new MobileDownloadResilienceExecutor(resolveBakedMqttHost()),
    new DownloadExecutor(),
    new LifecycleExecutor(resources),
    new RpcServerExecutor(),
    new SystemResourcesExecutor(Platform.OS),
    new ConfigExecutor(),
    new MobileCancellationExecutor(resources),
    new PluginExecutor(resources)
  ],
  profiling: {
    init: () => profiler.enable({ mode: 'summary', includeServerBreakdown: true }),
    exportData: () => profiler.exportJSON()
  }
})
