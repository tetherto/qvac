import { createExecutor, SkipExecutor, type TestDefinition } from '@qvac/test-suite'
import { createStepBindings } from '../shared/step-bindings.js'
import { profiler } from '@qvac/sdk'
import * as fs from 'node:fs'
import * as path from 'node:path'
import { ResourceManager } from '../shared/resource-manager.js'
import { collectTestDeps } from '../shared/collect-test-deps.js'
import { BatchCompletionExecutor } from '../shared/executors/batch-completion-executor.js'
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
import { VlaExecutor } from '../shared/executors/vla-executor.js'
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
import { NodeDiffusionExecutor } from '../shared/executors/node/diffusion-executor.js'
import { NodeWorldExecutor } from '../shared/executors/node/world-executor.js'
import { AudioGenExecutor } from '../shared/executors/audio-gen-executor.js'
import { FinetuneExecutor } from '../shared/executors/node/finetune-executor.js'
import { LifecycleExecutor } from '../shared/executors/lifecycle-executor.js'
import { SystemResourcesExecutor } from '../shared/executors/system-resources-executor.js'
import { ConfigExecutor } from '../shared/executors/config-executor.js'
import { NoLingeringBareExecutor } from '../shared/executors/node/no-lingering-bare-executor.js'
import { KvCacheRestartExecutor } from '../shared/executors/node/kv-cache-restart-executor.js'
import { MultiGpuExecutor } from '../shared/executors/multi-gpu-executor.js'
import { NodeCancellationExecutor } from '../shared/executors/node/cancellation-executor.js'
import { PluginExecutor } from '../shared/executors/plugin-executor.js'

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
  'desktop',
  (dep, definition) => resources.define(dep, definition as never),
  (name) => (MODEL_CONSTANTS as Record<string, unknown>)[name],
  (kind, file) => resolveTableAsset(kind, file)
)

function readJsonConfig(configPath: string) {
  return JSON.parse(fs.readFileSync(configPath, 'utf8')) as Record<string, unknown>
}

// Exercises registryDownloadMaxRetries + registryStreamTimeoutMs end-to-end (see config-tests.ts).
function ensureDesktopE2EConfig() {
  const fixturePath = path.resolve(process.cwd(), 'fixtures/qvac.config.e2e.json')
  const existingPath = process.env['QVAC_CONFIG_PATH']
  const fixtureConfig = readJsonConfig(fixturePath)
  const existingConfig = existingPath ? readJsonConfig(existingPath) : {}
  const mergedConfig = {
    ...fixtureConfig,
    ...existingConfig
  }
  const configuredPlugins = Array.isArray(mergedConfig['plugins'])
    ? mergedConfig['plugins'].filter((plugin): plugin is string => typeof plugin === 'string')
    : []
  const desktopConfig = {
    ...mergedConfig,
    plugins: Array.from(new Set([...configuredPlugins, '@qvac/sdk/audiogen-ggml/plugin']))
  }
  const generatedPath = path.resolve(process.cwd(), 'qvac.config.e2e.generated.json')

  fs.writeFileSync(generatedPath, `${JSON.stringify(desktopConfig, null, 2)}\n`)
  process.env['QVAC_CONFIG_PATH'] = generatedPath

  if (existingPath) {
    console.log(
      `📦 Desktop e2e config merged ${fixturePath} with ${existingPath}; using ${generatedPath}`
    )
  } else {
    console.log(`📦 Desktop e2e config set to ${generatedPath}`)
  }
}

function resolveBatchAttachmentPath(inputPath: string) {
  const fileName = inputPath.split('/').pop()
  if (!fileName) return inputPath
  return path.resolve(process.cwd(), 'assets/images', fileName)
}

export async function bootstrap(filteredTests?: TestDefinition[]) {
  ensureDesktopE2EConfig()

  // `filteredTests` (when present) is the producer's post-filter test list
  // delivered via register-ack; absence keeps the legacy "warm everything" path.
  const allowedDeps = filteredTests ? collectTestDeps(filteredTests) : undefined
  await resources.downloadAllOnce(console.log, { allowedDeps })
}

const stepBindings = createStepBindings(resources)

export const executor = createExecutor({
  handlers: [
    new SkipExecutor(
      /^snap-storage-/,
      'Snap storage tests require the strict-confined Snap consumer'
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
    new VlaExecutor(resources),
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
    new NodeDiffusionExecutor(resources),
    new NodeWorldExecutor(resources),
    new AudioGenExecutor(resources, {
      resolveAudioAsset: (fileName) => path.resolve(process.cwd(), 'assets/audio', fileName)
    }),
    new FinetuneExecutor(resources),
    new LifecycleExecutor(resources),
    new SystemResourcesExecutor(),
    new ConfigExecutor(),
    new NoLingeringBareExecutor(),
    new KvCacheRestartExecutor(resources),
    new MultiGpuExecutor(resources),
    new NodeCancellationExecutor(resources),
    new PluginExecutor(resources)
  ],
  profiling: {
    init: () => profiler.enable({ mode: 'summary', includeServerBreakdown: true }),
    exportData: () => profiler.exportJSON()
  }
})

// A definition carrying `steps` is run by the shared interpreter instead of the
// executor above. That is what makes JS the reference implementation rather
// than merely the first one: the same interpreter, over the same catalog, as
// every other client. Definitions without `steps` are untouched.
executor.stepBindings = stepBindings
