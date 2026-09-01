import test from 'brittle'
import fs, { promises as fsPromises } from 'bare-fs'
import path from 'bare-path'
import { HyperDBAdapter, TurboVecAdapter } from '@qvac/rag'
import { clearPlugins } from '@/plugins'
import {
  closeAllRagInstances,
  closeRagInstance,
  deleteWorkspace,
  getRagDbAdapter,
  isWorkspaceLoaded
} from '@/rag/rag-workspace-manager'
import { deleteWorkspace as handleDeleteWorkspace } from '@/rag/handlers/delete-workspace'
import {
  PathTraversalError,
  RAGWorkspaceInUseError,
  RAGWorkspaceNotOpenError
} from '@/errors/index'
import { getConfiguredCacheDir } from '@/runtime/state'
import { qvacConfigSchema } from '@/schemas/index'
import { getRegisteredResourceCounts } from '@/runtime/runtime-lifecycle'
import { observableIndexProvider, registerProviderPlugin } from './fixtures/turbovec-provider'

function workspaceName(suffix: string) {
  return `test-turbovec-provider-${suffix}-${Date.now()}-${Math.random().toString(16).slice(2)}`
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

async function pinTurbovecWorkspace(workspace: string) {
  const { storePath, indexPath } = workspacePaths(workspace)
  await fsPromises.mkdir(storePath, { recursive: true })
  await fsPromises.mkdir(indexPath, { recursive: true })
  await fsPromises.writeFile(
    path.join(storePath, '.qvac-rag-workspace.json'),
    `${JSON.stringify({ version: 1, adapterType: 'turbovec' })}\n`
  )
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

test('config validation rejects a non-boolean ragTurbovec value', (t) => {
  t.absent(
    qvacConfigSchema.safeParse({ ragTurbovec: 'true' }).success,
    'a string flag fails config validation'
  )
  t.absent(
    qvacConfigSchema.safeParse({ ragTurbovec: 1 }).success,
    'a numeric flag fails config validation'
  )
  t.ok(qvacConfigSchema.safeParse({ ragTurbovec: true }).success)
})

test('a new workspace defaults to HyperDB when ragTurbovec is not set', async (t) => {
  const workspace = workspaceName('default-adapter')
  clearPlugins()

  try {
    const adapter = await getRagDbAdapter(workspace)
    t.ok(adapter instanceof HyperDBAdapter)
  } finally {
    clearPlugins()
    await cleanupWorkspace(workspace)
  }
})

test('pinned TurboVec workspace uses a registered plugin provider', async (t) => {
  const workspace = workspaceName('registered')
  const { provider, calls } = observableIndexProvider()

  clearPlugins()
  registerProviderPlugin('test-turbovec-provider', provider)
  await pinTurbovecWorkspace(workspace)

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
    clearPlugins()
    await cleanupWorkspace(workspace)
  }
})

test('existing TurboVec layout with an unrecognized marker opens without a provider', async (t) => {
  const workspace = workspaceName('unrecognized-marker')
  const { storePath, indexPath } = workspacePaths(workspace)

  clearPlugins()
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
    clearPlugins()
    await cleanupWorkspace(workspace)
  }
})

test('null workspace marker falls back to the existing TurboVec layout', async (t) => {
  const workspace = workspaceName('null-marker')
  const { storePath, indexPath } = workspacePaths(workspace)

  clearPlugins()
  await fsPromises.mkdir(storePath, { recursive: true })
  await fsPromises.mkdir(indexPath, { recursive: true })
  await fsPromises.writeFile(path.join(storePath, '.qvac-rag-workspace.json'), 'null\n')

  try {
    const adapter = await getRagDbAdapter(workspace)
    t.ok(adapter instanceof TurboVecAdapter)
  } finally {
    clearPlugins()
    await cleanupWorkspace(workspace)
  }
})

test('existing HyperDB workspace opens when its marker cannot be written', async (t) => {
  const workspace = workspaceName('marker-write-failure')
  const originalReady = HyperDBAdapter.prototype.ready
  const { storePath } = workspacePaths(workspace)
  const markerPath = path.join(storePath, '.qvac-rag-workspace.json')

  clearPlugins()
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
    clearPlugins()
    await cleanupWorkspace(workspace)
  }
})

test('pinned TurboVec workspace recovers when its provider is registered later', async (t) => {
  const workspace = workspaceName('late-provider')
  const initial = observableIndexProvider()

  clearPlugins()
  registerProviderPlugin('test-turbovec-late-provider-initial', initial.provider)
  await pinTurbovecWorkspace(workspace)

  try {
    const initialAdapter = await getRagDbAdapter(workspace)
    t.ok(initialAdapter instanceof TurboVecAdapter)
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
    clearPlugins()
    await cleanupWorkspace(workspace)
  }
})

test('failed TurboVec open preserves workspace directories it did not create', async (t) => {
  const workspace = workspaceName('existing')
  const originalReady = TurboVecAdapter.prototype.ready
  const { storePath, indexPath } = workspacePaths(workspace)
  const indexSentinel = path.join(indexPath, 'index-owner')
  const initializationError = new Error('TurboVec initialization failed')

  clearPlugins()
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
    clearPlugins()
    await cleanupWorkspace(workspace)
  }
})

test('in-flight TurboVec open blocks deletion and is settled by shutdown', async (t) => {
  const workspace = workspaceName('opening-shutdown')
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
  await pinTurbovecWorkspace(workspace)
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
    clearPlugins()
    await cleanupWorkspace(workspace)
  }
})

test('closing during a failed in-flight open reports the workspace as not open', async (t) => {
  const workspace = workspaceName('opening-close-failure')
  const originalReady = TurboVecAdapter.prototype.ready
  const openError = new Error('TurboVec initialization failed')
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
  registerProviderPlugin('test-turbovec-opening-close-failure', provider)
  await pinTurbovecWorkspace(workspace)
  TurboVecAdapter.prototype.ready = async function () {
    markReadyStarted()
    await readyGate
    throw openError
  }

  let openPromise: Promise<TurboVecAdapter | HyperDBAdapter> | undefined
  try {
    openPromise = getRagDbAdapter(workspace)
    await readyStarted

    const closePromise = closeRagInstance(workspace)
    // Prevent an unhandled rejection while the open is released below.
    const closeOutcome = closePromise.then(
      () => undefined,
      (error) => error
    )
    releaseReady()

    await openPromise.then(
      () => t.fail('the gated open should fail'),
      (error) => t.is(error, openError, 'the open rejects with its own error')
    )
    const closeError = await closeOutcome
    t.ok(
      closeError instanceof RAGWorkspaceNotOpenError,
      'close reports not-open instead of rethrowing the open error'
    )
  } finally {
    releaseReady()
    if (openPromise) await openPromise.catch(() => undefined)
    TurboVecAdapter.prototype.ready = originalReady
    clearPlugins()
    await cleanupWorkspace(workspace)
  }
})

test('closing an in-flight TurboVec open waits for initialization', async (t) => {
  const workspace = workspaceName('opening-close')
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
  await pinTurbovecWorkspace(workspace)
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
    clearPlugins()
    await cleanupWorkspace(workspace)
  }
})
