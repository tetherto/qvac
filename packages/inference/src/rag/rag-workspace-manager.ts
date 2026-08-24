import {
  RAG,
  ERR_CODES,
  HyperDBAdapter,
  QvacErrorRAG,
  TurboVecAdapter,
  type EmbeddingFunction
} from '@qvac/rag'
import Corestore from 'corestore'
import env from 'bare-env'
import fs, { promises as fsPromises } from 'bare-fs'
import path from 'bare-path'
import { getConfiguredCacheDir } from '@/runtime/state'
import { RAGWorkspaceModelMismatchError, RAGWorkspaceNotOpenError } from '@/errors/index'
import { validateAndJoinPath } from '@/utils/path-security'
import { createStreamLogger, getEngineLogger, RAG_NAMESPACE } from '@/logging/index'
import { cancelAllRagOperations } from '@/rag/rag-operation-manager'
import { registerCorestore, unregisterCorestore } from '@/runtime/runtime-lifecycle'
import { getTurboVecIndexProvider } from '@/plugins/registry'

const logger = getEngineLogger()
const TURBOVEC_ROLLOUT_ENV = 'QVAC_RAG_TURBOVEC'

// Workspace-based RAG storage
interface RagWorkspaceEntry {
  corestore: Corestore
  dbAdapter: HyperDBAdapter
  rag?: RAG
  modelId?: string
}

const ragWorkspaces = new Map<string, RagWorkspaceEntry>()

export const DEFAULT_WORKSPACE = 'default'

function getWorkspaceKey(workspace?: string) {
  return workspace ?? DEFAULT_WORKSPACE
}

function getRagBaseDir() {
  const cacheDir = getConfiguredCacheDir()
  return path.join(path.dirname(cacheDir), 'rag-hyperdb')
}

function getRagIndexBaseDir() {
  const cacheDir = getConfiguredCacheDir()
  return path.join(path.dirname(cacheDir), 'rag-turbovec')
}

function getStorePath(workspace: string) {
  return validateAndJoinPath(getRagBaseDir(), workspace)
}

function getIndexPath(workspace: string) {
  return validateAndJoinPath(getRagIndexBaseDir(), workspace)
}

function createRagDbAdapter(corestore: Corestore, workspace: string) {
  if (env[TURBOVEC_ROLLOUT_ENV] !== '1') {
    return new HyperDBAdapter({
      store: corestore,
      dbName: workspace
    })
  }
  const indexProvider = getTurboVecIndexProvider()
  if (!indexProvider) {
    throw new QvacErrorRAG({
      code: ERR_CODES.DEPENDENCY_REQUIRED,
      adds: 'TurboVec requires a registered vector index provider'
    })
  }
  return new TurboVecAdapter({
    store: corestore,
    dbName: workspace,
    indexProvider,
    checkpointDir: getIndexPath(workspace)
  })
}

export function hasRagWorkspaceStorage(workspace?: string) {
  const key = getWorkspaceKey(workspace)
  if (ragWorkspaces.has(key)) return true
  return fs.existsSync(getStorePath(key))
}

async function getOrCreateWorkspaceEntry(workspace?: string) {
  const key = getWorkspaceKey(workspace)
  const existing = ragWorkspaces.get(key)
  if (existing) {
    return existing
  }

  const storePath = getStorePath(key)
  const corestore = new Corestore(storePath)

  let dbAdapter: HyperDBAdapter
  try {
    dbAdapter = createRagDbAdapter(corestore, key)
    await dbAdapter.ready()
  } catch (error) {
    try {
      await corestore.close()
    } catch {
      // Keep the adapter initialization error as the primary failure.
    }
    throw error
  }

  registerCorestore(corestore, {
    label: `rag-workspace:${key}`,
    createdAt: Date.now()
  })

  const entry: RagWorkspaceEntry = {
    corestore,
    dbAdapter
  }

  ragWorkspaces.set(key, entry)
  return entry
}

export async function getRagDbAdapter(workspace?: string) {
  const entry = await getOrCreateWorkspaceEntry(workspace)
  return entry.dbAdapter
}

export async function getRagInstance(
  modelId: string,
  embeddingFunction: EmbeddingFunction,
  workspace?: string
): Promise<RAG> {
  const key = getWorkspaceKey(workspace)
  const entry = await getOrCreateWorkspaceEntry(workspace)

  if (entry.rag) {
    if (entry.modelId && entry.modelId !== modelId) {
      throw new RAGWorkspaceModelMismatchError(key, entry.modelId, modelId)
    }
    return entry.rag
  }

  const workspaceLogger = createStreamLogger(key, RAG_NAMESPACE)

  const rag = new RAG({
    dbAdapter: entry.dbAdapter,
    embeddingFunction,
    logger: workspaceLogger
  })

  await rag.ready()
  entry.rag = rag
  entry.modelId = modelId

  return rag
}

export async function closeRagInstance(workspace?: string) {
  const key = getWorkspaceKey(workspace)
  const entry = ragWorkspaces.get(key)

  if (!entry) {
    throw new RAGWorkspaceNotOpenError(key)
  }

  if (entry.rag) {
    await entry.rag.close()
  }
  await entry.dbAdapter.close()
  await entry.corestore.close()
  unregisterCorestore(entry.corestore)
  ragWorkspaces.delete(key)
}

let isCleaningUp = false

export async function closeAllRagInstances() {
  if (isCleaningUp) return
  isCleaningUp = true

  try {
    cancelAllRagOperations()

    const closures = Array.from(ragWorkspaces.entries()).map(async ([key, entry]) => {
      if (entry.rag) {
        await entry.rag.close()
      }
      await entry.dbAdapter.close()
      await entry.corestore.close()
      unregisterCorestore(entry.corestore)
      ragWorkspaces.delete(key)
    })

    await Promise.all(closures)
  } catch (error) {
    logger.error('❌ Error during RAG cleanup:', error)
  } finally {
    isCleaningUp = false
  }
}

// ============== Workspace Management ==============

export interface RagWorkspaceInfo {
  name: string
  open: boolean
}

export function listWorkspaces(): RagWorkspaceInfo[] {
  const baseDir = getRagBaseDir()

  if (!fs.existsSync(baseDir)) {
    return []
  }

  const entries = fs.readdirSync(baseDir, {
    withFileTypes: true
  }) as unknown as Array<{
    name: string
    isDirectory: () => boolean
  }>

  const directories = entries.filter((entry) => entry.isDirectory() && !entry.name.startsWith('.'))

  return directories.map((entry) => ({
    name: entry.name,
    open: ragWorkspaces.has(entry.name)
  }))
}

export function isWorkspaceLoaded(workspace: string) {
  const key = getWorkspaceKey(workspace)
  return ragWorkspaces.has(key)
}

export async function deleteWorkspace(workspace: string) {
  const key = getWorkspaceKey(workspace)
  const storePath = getStorePath(key)
  const indexPath = getIndexPath(key)

  if (!fs.existsSync(storePath) && !fs.existsSync(indexPath)) {
    return false
  }

  await fsPromises.rm(storePath, { recursive: true, force: true })
  await fsPromises.rm(indexPath, { recursive: true, force: true })

  return true
}
