'use strict'

const test = require('brittle')
const FilesystemDL = require('@qvac/dl-filesystem')
const getTmpDir = require('test-tmp')
const LlmLlamacpp = require('../../index.js')
const {
  ensureModel,
  setupPauseResumeTestData,
  getDefaultFinetuneConfig,
  cleanupCheckpoints
} = require('./utils')
const { attachSpecLogger } = require('./spec-logger')
const os = require('bare-os')

const platform = os.platform()
const arch = os.arch()
const isDarwinX64 = platform === 'darwin' && arch === 'x64'
const isLinuxArm64 = platform === 'linux' && arch === 'arm64'
const useCpu = isDarwinX64 || isLinuxArm64

const FINETUNE_MODEL = {
  name: 'Qwen3-0.6B-Q8_0.gguf',
  url: 'https://huggingface.co/unsloth/Qwen3-0.6B-GGUF/resolve/main/Qwen3-0.6B-Q8_0.gguf'
}

const RUN_PROMPT = [
  { role: 'system', content: 'You are a helpful assistant.' },
  { role: 'user', content: 'Say "ok" once.' }
]

const BUSY_ERROR = /A finetune or run is already in progress\. Wait for it to complete or pause before calling run\(\) or finetune\(\) again\./

const FINETUNE_TIMEOUT_MS = 360_000

function sleep (ms) {
  return new Promise(resolve => setTimeout(resolve, ms))
}

test('finetune() throws when previous finetune() is still running', { timeout: FINETUNE_TIMEOUT_MS, skip: isDarwinX64 }, async (t) => {
  const [modelName, modelDir] = await ensureModel({
    modelName: FINETUNE_MODEL.name,
    downloadUrl: FINETUNE_MODEL.url
  })
  const testDataDir = await getTmpDir()
  const testCheckpointDir = await getTmpDir()
  const { trainDatasetPath, evalDatasetPath, checkpointDir } = setupPauseResumeTestData(
    testDataDir, testCheckpointDir, 'concurrent-1'
  )
  const loader = new FilesystemDL({ dirPath: modelDir })
  const loggerHandle = attachSpecLogger({ forwardToConsole: false })
  const config = {
    gpu_layers: '999',
    ctx_size: '512',
    device: useCpu ? 'cpu' : 'gpu',
    flash_attn: 'off'
  }
  const finetuneConfig = getDefaultFinetuneConfig({
    trainDatasetDir: trainDatasetPath,
    evalDatasetDir: evalDatasetPath,
    numberOfEpochs: 1,
    microBatchSize: 2,
    contextLength: 128,
    checkpointSaveDir: checkpointDir
  })
  const model = new LlmLlamacpp(
    { loader, modelName, diskPath: modelDir, logger: console, opts: { stats: true } },
    config,
    finetuneConfig
  )
  t.teardown(async () => {
    try {
      loggerHandle.release()
      await model.unload().catch(() => {})
      await loader.close().catch(() => {})
      cleanupCheckpoints(checkpointDir)
    } catch (err) {}
  })
  await model.load()

  const handle = await model.finetune(finetuneConfig)
  await t.exception(
    () => model.finetune(finetuneConfig),
    BUSY_ERROR
  )
  await model.pauseFinetune()
  const result = await handle.await()
  t.ok(result?.status === 'PAUSED' || result?.status === 'IDLE', `expected PAUSED or IDLE, got ${result?.status}`)
  t.pass()
})

test('run() throws when finetune() is still running', { timeout: FINETUNE_TIMEOUT_MS, skip: isDarwinX64 }, async (t) => {
  const [modelName, modelDir] = await ensureModel({
    modelName: FINETUNE_MODEL.name,
    downloadUrl: FINETUNE_MODEL.url
  })
  const testDataDir = await getTmpDir()
  const testCheckpointDir = await getTmpDir()
  const { trainDatasetPath, evalDatasetPath, checkpointDir } = setupPauseResumeTestData(
    testDataDir, testCheckpointDir, 'concurrent-2'
  )
  const loader = new FilesystemDL({ dirPath: modelDir })
  const loggerHandle = attachSpecLogger({ forwardToConsole: false })
  const config = {
    gpu_layers: '999',
    ctx_size: '512',
    device: useCpu ? 'cpu' : 'gpu',
    flash_attn: 'off'
  }
  const finetuneConfig = getDefaultFinetuneConfig({
    trainDatasetDir: trainDatasetPath,
    evalDatasetDir: evalDatasetPath,
    numberOfEpochs: 1,
    microBatchSize: 2,
    contextLength: 128,
    checkpointSaveDir: checkpointDir
  })
  const model = new LlmLlamacpp(
    { loader, modelName, diskPath: modelDir, logger: console, opts: { stats: true } },
    config,
    finetuneConfig
  )
  t.teardown(async () => {
    try {
      loggerHandle.release()
      await model.unload().catch(() => {})
      await loader.close().catch(() => {})
      cleanupCheckpoints(checkpointDir)
    } catch (err) {}
  })
  await model.load()

  const handle = await model.finetune(finetuneConfig)
  await t.exception(
    () => model.run(RUN_PROMPT),
    BUSY_ERROR
  )
  await model.pauseFinetune()
  await handle.await()
  t.pass()
})

test('finetune() throws when run() is still running', { timeout: FINETUNE_TIMEOUT_MS, skip: isDarwinX64 }, async (t) => {
  const [modelName, modelDir] = await ensureModel({
    modelName: FINETUNE_MODEL.name,
    downloadUrl: FINETUNE_MODEL.url
  })
  const testDataDir = await getTmpDir()
  const testCheckpointDir = await getTmpDir()
  const { trainDatasetPath, evalDatasetPath, checkpointDir } = setupPauseResumeTestData(
    testDataDir, testCheckpointDir, 'concurrent-3'
  )
  const loader = new FilesystemDL({ dirPath: modelDir })
  const loggerHandle = attachSpecLogger({ forwardToConsole: false })
  const config = {
    gpu_layers: '999',
    ctx_size: '512',
    device: useCpu ? 'cpu' : 'gpu',
    flash_attn: 'off'
  }
  const finetuneConfig = getDefaultFinetuneConfig({
    trainDatasetDir: trainDatasetPath,
    evalDatasetDir: evalDatasetPath,
    numberOfEpochs: 1,
    microBatchSize: 2,
    contextLength: 128,
    checkpointSaveDir: checkpointDir
  })
  const model = new LlmLlamacpp(
    { loader, modelName, diskPath: modelDir, logger: console, opts: { stats: true } },
    config,
    finetuneConfig
  )
  t.teardown(async () => {
    try {
      loggerHandle.release()
      await model.unload().catch(() => {})
      await loader.close().catch(() => {})
      cleanupCheckpoints(checkpointDir)
    } catch (err) {}
  })
  await model.load()

  const runPromise = model.run(RUN_PROMPT)
  await Promise.resolve()
  await t.exception(
    () => model.finetune(finetuneConfig),
    BUSY_ERROR
  )
  await runPromise
  t.pass()
})

test('run() throws when previous run() is still running', { timeout: FINETUNE_TIMEOUT_MS, skip: isDarwinX64 }, async (t) => {
  const [modelName, modelDir] = await ensureModel({
    modelName: FINETUNE_MODEL.name,
    downloadUrl: FINETUNE_MODEL.url
  })
  const loader = new FilesystemDL({ dirPath: modelDir })
  const loggerHandle = attachSpecLogger({ forwardToConsole: false })
  const config = {
    gpu_layers: '999',
    ctx_size: '512',
    device: useCpu ? 'cpu' : 'gpu',
    flash_attn: 'off'
  }
  const model = new LlmLlamacpp(
    { loader, modelName, diskPath: modelDir, logger: console, opts: { stats: true } },
    config
  )
  t.teardown(async () => {
    try {
      loggerHandle.release()
      await model.unload().catch(() => {})
      await loader.close().catch(() => {})
    } catch (err) {}
  })
  await model.load()

  const runPromise = model.run(RUN_PROMPT)
  await Promise.resolve()
  await t.exception(
    () => model.run(RUN_PROMPT),
    BUSY_ERROR
  )
  await runPromise
  t.pass()
})

test('pauseFinetune() does not throw when not finetuning', { timeout: FINETUNE_TIMEOUT_MS, skip: isDarwinX64 }, async (t) => {
  const [modelName, modelDir] = await ensureModel({
    modelName: FINETUNE_MODEL.name,
    downloadUrl: FINETUNE_MODEL.url
  })
  const loader = new FilesystemDL({ dirPath: modelDir })
  const loggerHandle = attachSpecLogger({ forwardToConsole: false })
  const config = {
    gpu_layers: '999',
    ctx_size: '512',
    device: useCpu ? 'cpu' : 'gpu',
    flash_attn: 'off'
  }
  const model = new LlmLlamacpp(
    { loader, modelName, diskPath: modelDir, logger: console, opts: { stats: true } },
    config
  )
  t.teardown(async () => {
    try {
      loggerHandle.release()
      await model.unload().catch(() => {})
      await loader.close().catch(() => {})
    } catch (err) {}
  })
  await model.load()

  await t.execution(async () => {
    await model.pauseFinetune()
  })
  t.pass()
})

test('pauseFinetune() does not throw when finetune is running', { timeout: FINETUNE_TIMEOUT_MS, skip: isDarwinX64 }, async (t) => {
  const [modelName, modelDir] = await ensureModel({
    modelName: FINETUNE_MODEL.name,
    downloadUrl: FINETUNE_MODEL.url
  })
  const testDataDir = await getTmpDir()
  const testCheckpointDir = await getTmpDir()
  const { trainDatasetPath, evalDatasetPath, checkpointDir } = setupPauseResumeTestData(
    testDataDir, testCheckpointDir, 'concurrent-4'
  )
  const loader = new FilesystemDL({ dirPath: modelDir })
  const loggerHandle = attachSpecLogger({ forwardToConsole: false })
  const config = {
    gpu_layers: '999',
    ctx_size: '512',
    device: useCpu ? 'cpu' : 'gpu',
    flash_attn: 'off'
  }
  const finetuneConfig = getDefaultFinetuneConfig({
    trainDatasetDir: trainDatasetPath,
    evalDatasetDir: evalDatasetPath,
    numberOfEpochs: 1,
    microBatchSize: 2,
    contextLength: 128,
    checkpointSaveDir: checkpointDir
  })
  const model = new LlmLlamacpp(
    { loader, modelName, diskPath: modelDir, logger: console, opts: { stats: true } },
    config,
    finetuneConfig
  )
  t.teardown(async () => {
    try {
      loggerHandle.release()
      await model.unload().catch(() => {})
      await loader.close().catch(() => {})
      cleanupCheckpoints(checkpointDir)
    } catch (err) {}
  })
  await model.load()

  const handle = await model.finetune(finetuneConfig)
  await sleep(5000)
  await t.execution(async () => {
    await model.pauseFinetune()
  })
  const result = await handle.await()
  t.ok(result?.status === 'PAUSED' || result?.status === 'IDLE', `expected PAUSED or IDLE, got ${result?.status}`)
  t.pass()
})
