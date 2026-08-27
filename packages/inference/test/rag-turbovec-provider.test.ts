import test from 'brittle'
import env from 'bare-env'
import fs, { promises as fsPromises } from 'bare-fs'
import path from 'bare-path'
import { z } from 'zod'
import {
  ERR_CODES,
  HyperDBAdapter,
  QvacErrorRAG,
  TurboVecAdapter,
  type TurboVecIndex,
  type TurboVecIndexProvider
} from '@qvac/rag'
import { clearPlugins, registerPlugin } from '@/plugins'
import {
  closeAllRagInstances,
  closeRagInstance,
  deleteWorkspace,
  getRagDbAdapter,
  isWorkspaceLoaded
} from '@/rag/rag-workspace-manager'
import { deleteWorkspace as handleDeleteWorkspace } from '@/rag/handlers/delete-workspace'
import { PathTraversalError, RAGWorkspaceInUseError } from '@/errors/index'
import { getEnv, initEnv } from '@/runtime/env'
import { getConfiguredCacheDir } from '@/runtime/state'
import { getRegisteredResourceCounts } from '@/runtime/runtime-lifecycle'

const TURBOVEC_ROLLOUT_ENV = 'QVAC_RAG_TURBOVEC'

function workspaceName(suffix: string) {
  return `test-turbovec-provider-${suffix}-${Date.now()}-${Math.random().toString(16).slice(2)}`
}

function restoreEnv(value: string | undefined) {
  env[TURBOVEC_ROLLOUT_ENV] = value ?? ''
}

async function cleanupWorkspace(workspace: string) {
  if (isWorkspaceLoaded(workspace)) {
    await closeRagInstance(workspace)
  }
  await deleteWorkspace(workspace)
}

function workspacePaths(workspace: string) {
  const baseDir = path.dirname(getConfiguredCacheDir())
  return {
    storePath: path.join(baseDir, 'rag-hyperdb', workspace),
    indexPath: path.join(baseDir, 'rag-turbovec', workspace)
  }
}

function observableIndexProvider() {
  const calls = { create: 0, load: 0, addWithIds: 0, search: 0 }

  function createIndex(dim: number): TurboVecIndex {
    const indexIds: bigint[] = []
    return {
      get length() {
        return indexIds.length
      },
      dim,
      addWithIds(_vectors, ids) {
        calls.addWithIds++
        for (const id of ids) indexIds.push(id)
      },
      search(_queries, k) {
        calls.search++
        const ids = indexIds.slice(0, k)
        return {
          scores: new Float32Array(ids.length).fill(1),
          ids: new BigUint64Array(ids),
          m: 1,
          k: ids.length
        }
      },
      contains(id) {
        return indexIds.includes(id)
      },
      remove(id) {
        const index = indexIds.indexOf(id)
        if (index === -1) return false
        indexIds.splice(index, 1)
        return true
      },
      prepare() {},
      write(snapshotPath) {
        fs.writeFileSync(snapshotPath, 'test index\n')
      },
      dispose() {}
    }
  }

  const provider: TurboVecIndexProvider = {
    create(options) {
      calls.create++
      return createIndex(options.dim)
    },
    load() {
      calls.load++
      return createIndex(8)
    }
  }
  return { provider, calls }
}

function registerProviderPlugin(modelType: string, provider: TurboVecIndexProvider) {
  registerPlugin({
    modelType,
    displayName: modelType,
    addonPackage: '@qvac/test-addon',
    loadConfigSchema: z.object({}),
    createModel() {
      return {
        model: { load: async function () {} }
      }
    },
    handlers: {},
    capabilities: {
      turbovecIndexProvider: provider
    }
  })
}

test('workspace paths cannot resolve to the RAG storage roots', async (t) => {
  const baseDir = path.dirname(getConfiguredCacheDir())
  const storeRoot = path.join(baseDir, 'rag-hyperdb')
  const indexRoot = path.join(baseDir, 'rag-turbovec')
  const sentinelName = `.root-sentinel-${Date.now()}-${Math.random().toString(16).slice(2)}`
  const storeSentinel = path.join(storeRoot, sentinelName)
  const indexSentinel = path.join(indexRoot, sentinelName)

  await fsPromises.mkdir(storeRoot, { recursive: true })
  await fsPromises.mkdir(indexRoot, { recursive: true })
  await fsPromises.writeFile(storeSentinel, 'preserve store root\n')
  await fsPromises.writeFile(indexSentinel, 'preserve index root\n')

  try {
    try {
      await getRagDbAdapter('.')
      t.fail('opening the RAG root as a workspace should fail')
    } catch (error) {
      t.ok(error instanceof PathTraversalError)
    }

    try {
      await deleteWorkspace('.')
      t.fail('deleting the RAG root as a workspace should fail')
    } catch (error) {
      t.ok(error instanceof PathTraversalError)
    }

    t.ok(fs.existsSync(storeSentinel), 'the HyperDB root is preserved')
    t.ok(fs.existsSync(indexSentinel), 'the TurboVec root is preserved')
  } finally {
    await fsPromises.rm(storeSentinel, { force: true })
    await fsPromises.rm(indexSentinel, { force: true })
  }
})

test('TurboVec workspace failure leaves the workspace unpinned', async (t) => {
  const workspace = workspaceName('missing')
  const originalFlag = env[TURBOVEC_ROLLOUT_ENV]
  clearPlugins()
  env[TURBOVEC_ROLLOUT_ENV] = '1'

  try {
    try {
      await getRagDbAdapter(workspace)
      t.fail('workspace creation should require a provider')
    } catch (error) {
      t.ok(error instanceof QvacErrorRAG)
      if (error instanceof QvacErrorRAG) {
        t.is(error.code, ERR_CODES.DEPENDENCY_REQUIRED)
      }
    }

    env[TURBOVEC_ROLLOUT_ENV] = '0'
    const adapter = await getRagDbAdapter(workspace)
    t.ok(adapter instanceof HyperDBAdapter)
  } finally {
    restoreEnv(originalFlag)
    clearPlugins()
    await cleanupWorkspace(workspace)
  }
})

test('TurboVec workspace consumes a registered plugin provider', async (t) => {
  const workspace = workspaceName('registered')
  const originalFlag = env[TURBOVEC_ROLLOUT_ENV]
  const { provider, calls } = observableIndexProvider()

  clearPlugins()
  registerProviderPlugin('test-turbovec-provider', provider)
  env[TURBOVEC_ROLLOUT_ENV] = '1'

  try {
    const adapter = await getRagDbAdapter(workspace)
    t.ok(adapter instanceof TurboVecAdapter)
    await adapter.saveEmbeddings([
      {
        id: 'registered-provider',
        content: 'registered provider document',
        embeddingModelId: 'test-model',
        embedding: [1, 0, 0, 0, 0, 0, 0, 0]
      }
    ])
    const results = await adapter.search('registered provider', [1, 0, 0, 0, 0, 0, 0, 0], {
      topK: 1
    })
    t.ok(calls.create > 0, 'the registered provider creates the native index')
    t.is(calls.addWithIds, 1, 'the native index receives the saved embedding')
    t.ok(calls.search > 0, 'search uses the native index')
    t.is(results[0]?.id, 'registered-provider')
  } finally {
    restoreEnv(originalFlag)
    clearPlugins()
    await cleanupWorkspace(workspace)
  }
})

test('existing TurboVec layout with an unrecognized marker opens without a provider', async (t) => {
  const workspace = workspaceName('unrecognized-marker')
  const originalFlag = env[TURBOVEC_ROLLOUT_ENV]
  const { storePath, indexPath } = workspacePaths(workspace)

  clearPlugins()
  env[TURBOVEC_ROLLOUT_ENV] = '0'
  await fsPromises.mkdir(storePath, { recursive: true })
  await fsPromises.mkdir(indexPath, { recursive: true })
  await fsPromises.writeFile(
    path.join(storePath, '.qvac-rag-workspace.json'),
    `${JSON.stringify({ version: 2, adapterType: 'turbovec' })}\n`
  )

  try {
    const adapter = await getRagDbAdapter(workspace)
    t.ok(adapter instanceof TurboVecAdapter)
  } finally {
    restoreEnv(originalFlag)
    clearPlugins()
    await cleanupWorkspace(workspace)
  }
})

test('null workspace marker falls back to the existing TurboVec layout', async (t) => {
  const workspace = workspaceName('null-marker')
  const originalFlag = env[TURBOVEC_ROLLOUT_ENV]
  const { storePath, indexPath } = workspacePaths(workspace)

  clearPlugins()
  env[TURBOVEC_ROLLOUT_ENV] = '0'
  await fsPromises.mkdir(storePath, { recursive: true })
  await fsPromises.mkdir(indexPath, { recursive: true })
  await fsPromises.writeFile(path.join(storePath, '.qvac-rag-workspace.json'), 'null\n')

  try {
    const adapter = await getRagDbAdapter(workspace)
    t.ok(adapter instanceof TurboVecAdapter)
  } finally {
    restoreEnv(originalFlag)
    clearPlugins()
    await cleanupWorkspace(workspace)
  }
})

test('existing HyperDB workspace opens when its marker cannot be written', async (t) => {
  const workspace = workspaceName('marker-write-failure')
  const originalFlag = env[TURBOVEC_ROLLOUT_ENV]
  const originalReady = HyperDBAdapter.prototype.ready
  const { storePath } = workspacePaths(workspace)
  const markerPath = path.join(storePath, '.qvac-rag-workspace.json')

  clearPlugins()
  env[TURBOVEC_ROLLOUT_ENV] = '0'
  await fsPromises.mkdir(storePath, { recursive: true })
  HyperDBAdapter.prototype.ready = async function () {
    await originalReady.call(this)
    await fsPromises.chmod(storePath, 0o500)
  }

  try {
    const adapter = await getRagDbAdapter(workspace)
    t.ok(adapter instanceof HyperDBAdapter)
    await fsPromises.chmod(storePath, 0o700)
    t.absent(fs.existsSync(markerPath))
  } finally {
    HyperDBAdapter.prototype.ready = originalReady
    if (fs.existsSync(storePath)) await fsPromises.chmod(storePath, 0o700)
    restoreEnv(originalFlag)
    clearPlugins()
    await cleanupWorkspace(workspace)
  }
})

test('argv rollout overlay selects TurboVec for a new workspace', async (t) => {
  const workspace = workspaceName('argv-rollout')
  const originalFlag = env[TURBOVEC_ROLLOUT_ENV]
  const originalArgv = Bare.argv.slice()
  const homeDir = getEnv().HOME_DIR
  const { provider } = observableIndexProvider()

  clearPlugins()
  registerProviderPlugin('test-turbovec-argv-rollout', provider)
  env[TURBOVEC_ROLLOUT_ENV] = '0'
  Bare.argv.length = 0
  Bare.argv.push(
    'react-native-bare-kit',
    '',
    JSON.stringify({ HOME_DIR: homeDir, QVAC_RAG_TURBOVEC: '1' })
  )
  initEnv()

  try {
    const adapter = await getRagDbAdapter(workspace)
    t.ok(adapter instanceof TurboVecAdapter)
  } finally {
    Bare.argv.length = 0
    Bare.argv.push(...originalArgv)
    restoreEnv(originalFlag)
    initEnv()
    clearPlugins()
    await cleanupWorkspace(workspace)
  }
})

test('RAG workspace keeps its pinned adapter when the rollout flag changes', async (t) => {
  const turboWorkspace = workspaceName('pinned-turbo')
  const hyperdbWorkspace = workspaceName('pinned-hyperdb')
  const originalFlag = env[TURBOVEC_ROLLOUT_ENV]
  const { provider } = observableIndexProvider()

  clearPlugins()
  registerProviderPlugin('test-turbovec-pin', provider)

  try {
    env[TURBOVEC_ROLLOUT_ENV] = '1'
    const turboAdapter = await getRagDbAdapter(turboWorkspace)
    t.ok(turboAdapter instanceof TurboVecAdapter)
    await closeRagInstance(turboWorkspace)

    env[TURBOVEC_ROLLOUT_ENV] = '0'
    const reopenedTurboAdapter = await getRagDbAdapter(turboWorkspace)
    t.ok(reopenedTurboAdapter instanceof TurboVecAdapter)
    await closeRagInstance(turboWorkspace)

    const hyperdbAdapter = await getRagDbAdapter(hyperdbWorkspace)
    t.ok(hyperdbAdapter instanceof HyperDBAdapter)
    await closeRagInstance(hyperdbWorkspace)

    env[TURBOVEC_ROLLOUT_ENV] = '1'
    const reopenedHyperdbAdapter = await getRagDbAdapter(hyperdbWorkspace)
    t.ok(reopenedHyperdbAdapter instanceof HyperDBAdapter)
  } finally {
    restoreEnv(originalFlag)
    clearPlugins()
    await cleanupWorkspace(turboWorkspace)
    await cleanupWorkspace(hyperdbWorkspace)
  }
})

test('pinned TurboVec workspace recovers when its provider is registered later', async (t) => {
  const workspace = workspaceName('late-provider')
  const originalFlag = env[TURBOVEC_ROLLOUT_ENV]
  const initial = observableIndexProvider()

  clearPlugins()
  registerProviderPlugin('test-turbovec-late-provider-initial', initial.provider)

  try {
    env[TURBOVEC_ROLLOUT_ENV] = '1'
    const initialAdapter = await getRagDbAdapter(workspace)
    await initialAdapter.saveEmbeddings([
      {
        id: 'late-provider',
        content: 'late provider document',
        embeddingModelId: 'test-model',
        embedding: [1, 0, 0, 0, 0, 0, 0, 0]
      }
    ])
    await closeRagInstance(workspace)

    clearPlugins()
    env[TURBOVEC_ROLLOUT_ENV] = '0'
    const reopenedAdapter = await getRagDbAdapter(workspace)
    t.ok(reopenedAdapter instanceof TurboVecAdapter)
    const degradedResults = await reopenedAdapter.search(
      'late provider',
      [1, 0, 0, 0, 0, 0, 0, 0],
      { topK: 1 }
    )
    t.is(degradedResults[0]?.id, 'late-provider', 'the pinned workspace scans without a plugin')

    const late = observableIndexProvider()
    registerProviderPlugin('test-turbovec-late-provider-recovery', late.provider)
    await reopenedAdapter.reindex()
    const indexedResults = await reopenedAdapter.search('late provider', [1, 0, 0, 0, 0, 0, 0, 0], {
      topK: 1
    })
    t.ok(late.calls.create > 0, 'reindex picks up the late provider')
    t.ok(late.calls.addWithIds > 0, 'reindex adds stored vectors to the late provider')
    t.ok(late.calls.search > 0, 'later searches use the recovered native index')
    t.is(indexedResults[0]?.id, 'late-provider')
  } finally {
    restoreEnv(originalFlag)
    clearPlugins()
    await cleanupWorkspace(workspace)
  }
})

test('failed TurboVec open preserves workspace directories it did not create', async (t) => {
  const workspace = workspaceName('existing')
  const originalFlag = env[TURBOVEC_ROLLOUT_ENV]
  const originalReady = TurboVecAdapter.prototype.ready
  const { storePath, indexPath } = workspacePaths(workspace)
  const indexSentinel = path.join(indexPath, 'index-owner')
  const initializationError = new Error('TurboVec initialization failed')

  clearPlugins()
  env[TURBOVEC_ROLLOUT_ENV] = '1'
  await fsPromises.mkdir(storePath, { recursive: true })
  await fsPromises.mkdir(indexPath, { recursive: true })
  await fsPromises.writeFile(indexSentinel, 'owned elsewhere\n')
  TurboVecAdapter.prototype.ready = async function () {
    throw initializationError
  }

  try {
    try {
      await getRagDbAdapter(workspace)
      t.fail('workspace initialization should fail')
    } catch (error) {
      t.is(error, initializationError)
    }

    t.ok(fs.existsSync(storePath), 'the existing store directory is preserved')
    t.ok(fs.existsSync(indexSentinel), 'the existing index directory is preserved')
  } finally {
    TurboVecAdapter.prototype.ready = originalReady
    restoreEnv(originalFlag)
    clearPlugins()
    await cleanupWorkspace(workspace)
  }
})

test('in-flight TurboVec open blocks deletion and is settled by shutdown', async (t) => {
  const workspace = workspaceName('opening-shutdown')
  const originalFlag = env[TURBOVEC_ROLLOUT_ENV]
  const originalReady = TurboVecAdapter.prototype.ready
  const storesBefore = getRegisteredResourceCounts().stores
  let markReadyStarted = () => {}
  let releaseReady = () => {}
  const readyStarted = new Promise<void>((resolve) => {
    markReadyStarted = resolve
  })
  const readyGate = new Promise<void>((resolve) => {
    releaseReady = resolve
  })
  const { provider } = observableIndexProvider()

  clearPlugins()
  registerProviderPlugin('test-turbovec-opening-shutdown', provider)
  env[TURBOVEC_ROLLOUT_ENV] = '1'
  TurboVecAdapter.prototype.ready = async function () {
    markReadyStarted()
    await readyGate
    return originalReady.call(this)
  }

  let shutdownPromise: Promise<void> | undefined
  let openPromise: Promise<TurboVecAdapter | HyperDBAdapter> | undefined
  try {
    openPromise = getRagDbAdapter(workspace)
    const openSettled = openPromise.then(
      () => undefined,
      () => undefined
    )
    await readyStarted

    t.ok(isWorkspaceLoaded(workspace), 'the opening workspace is reported as loaded')

    try {
      await handleDeleteWorkspace({ workspace })
      t.fail('the delete handler should reject an opening workspace')
    } catch (error) {
      t.ok(error instanceof RAGWorkspaceInUseError)
    }

    try {
      await deleteWorkspace(workspace)
      t.fail('the manager should reject deletion while the workspace is opening')
    } catch (error) {
      t.ok(error instanceof RAGWorkspaceInUseError)
    }

    let shutdownSettled = false
    shutdownPromise = closeAllRagInstances()
    void shutdownPromise.then(() => {
      shutdownSettled = true
    })
    await Promise.resolve()
    t.absent(shutdownSettled, 'shutdown waits for the opening workspace')

    releaseReady()
    await shutdownPromise
    await openSettled

    t.absent(isWorkspaceLoaded(workspace), 'shutdown leaves no loaded workspace')
    t.is(
      getRegisteredResourceCounts().stores,
      storesBefore,
      'the opening Corestore is not registered after shutdown'
    )
  } finally {
    releaseReady()
    if (shutdownPromise) await shutdownPromise
    if (openPromise) await openPromise.catch(() => undefined)
    TurboVecAdapter.prototype.ready = originalReady
    restoreEnv(originalFlag)
    clearPlugins()
    await cleanupWorkspace(workspace)
  }
})

test('closing an in-flight TurboVec open waits for initialization', async (t) => {
  const workspace = workspaceName('opening-close')
  const originalFlag = env[TURBOVEC_ROLLOUT_ENV]
  const originalReady = TurboVecAdapter.prototype.ready
  let markReadyStarted = () => {}
  let releaseReady = () => {}
  const readyStarted = new Promise<void>((resolve) => {
    markReadyStarted = resolve
  })
  const readyGate = new Promise<void>((resolve) => {
    releaseReady = resolve
  })
  const { provider } = observableIndexProvider()

  clearPlugins()
  registerProviderPlugin('test-turbovec-opening-close', provider)
  env[TURBOVEC_ROLLOUT_ENV] = '1'
  TurboVecAdapter.prototype.ready = async function () {
    markReadyStarted()
    await readyGate
    return originalReady.call(this)
  }

  let openPromise: Promise<TurboVecAdapter | HyperDBAdapter> | undefined
  let closePromise: Promise<void> | undefined
  try {
    openPromise = getRagDbAdapter(workspace)
    await readyStarted

    let closeSettled = false
    closePromise = closeRagInstance(workspace)
    void closePromise.then(() => {
      closeSettled = true
    })
    await Promise.resolve()
    t.absent(closeSettled, 'close waits for workspace initialization')

    releaseReady()
    await openPromise
    await closePromise

    t.absent(isWorkspaceLoaded(workspace))
  } finally {
    releaseReady()
    if (openPromise) await openPromise.catch(() => undefined)
    if (closePromise) await closePromise.catch(() => undefined)
    TurboVecAdapter.prototype.ready = originalReady
    restoreEnv(originalFlag)
    clearPlugins()
    await cleanupWorkspace(workspace)
  }
})
