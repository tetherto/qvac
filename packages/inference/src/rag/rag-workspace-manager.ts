import {
  RAG,
  ERR_CODES,
  HyperDBAdapter,
  QvacErrorRAG,
  TurboVecAdapter,
  type EmbeddingFunction,
  type TurboVecIndexProvider
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
const WORKSPACE_MARKER_FILE = '.qvac-rag-workspace.json'
const WORKSPACE_MARKER_VERSION = 1

type RagAdapterType = 'hyperdb' | 'turbovec'
type RagDbAdapter = HyperDBAdapter | TurboVecAdapter

interface RagWorkspaceMarker {
  version: number
  adapterType: RagAdapterType
}

// Workspace-based RAG storage
interface RagWorkspaceEntry {
  corestore: Corestore
  dbAdapter: RagDbAdapter
  rag?: RAG
  modelId?: string
}

const ragWorkspaces = new Map<string, RagWorkspaceEntry>()
// Track workspace opens in progress. Concurrent callers wait for the same
// attempt, so one failed open cannot remove another caller's workspace.
const openingWorkspaces = new Map<string, Promise<RagWorkspaceEntry>>()

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

function missingIndexProviderError(workspace: string) {
  return new QvacErrorRAG({
    code: ERR_CODES.DEPENDENCY_REQUIRED,
    adds: `RAG workspace '${workspace}' needs a TurboVec index provider; register a plugin that exposes the turbovecIndexProvider capability`
  })
}

// Fallback for a pinned TurboVec workspace when its plugin is missing.
// The adapter catches these failures and scans HyperDB until the plugin returns.
function createUnavailableIndexProvider(workspace: string): TurboVecIndexProvider {
  return {
    create() {
      throw missingIndexProviderError(workspace)
    },
    load() {
      throw missingIndexProviderError(workspace)
    }
  }
}

function createRagDbAdapter(
  corestore: Corestore,
  workspace: string,
  adapterType: RagAdapterType,
  isPinned: boolean
) {
  if (adapterType === 'hyperdb') {
    return new HyperDBAdapter({
      store: corestore,
      dbName: workspace
    })
  }
  const indexProvider = getTurboVecIndexProvider()
  if (!indexProvider && !isPinned) {
    throw missingIndexProviderError(workspace)
  }
  if (!indexProvider) {
    logger.warn(
      `RAG workspace '${workspace}' is pinned to TurboVec but no index provider is registered; searches will scan the store directly`
    )
  }
  return new TurboVecAdapter({
    store: corestore,
    dbName: workspace,
    indexProvider: indexProvider || createUnavailableIndexProvider(workspace),
    checkpointDir: getIndexPath(workspace)
  })
}

function getRequestedAdapterType(): RagAdapterType {
  return env[TURBOVEC_ROLLOUT_ENV] === '1' ? 'turbovec' : 'hyperdb'
}

function unreadableMarkerError(markerPath: string, cause: unknown) {
  return new QvacErrorRAG({
    code: ERR_CODES.DB_OPERATION_FAILED,
    adds: `RAG workspace adapter marker could not be read (${markerPath}); retry once the file is accessible`,
    cause: cause instanceof Error ? cause : undefined
  })
}

function parseWorkspaceMarker(contents: string): RagAdapterType | null {
  let marker: RagWorkspaceMarker
  try {
    marker = JSON.parse(contents) as RagWorkspaceMarker
  } catch {
    return null
  }
  if (marker.version !== WORKSPACE_MARKER_VERSION) return null
  if (marker.adapterType !== 'hyperdb' && marker.adapterType !== 'turbovec') return null
  return marker.adapterType
}

function detectExistingAdapterType(workspace: string): RagAdapterType {
  return fs.existsSync(getIndexPath(workspace)) ? 'turbovec' : 'hyperdb'
}

interface WorkspaceMarkerState {
  // The adapter in a valid marker, or null if there is none.
  adapterType: RagAdapterType | null
  // True if a marker file exists. Unsupported markers are not overwritten.
  present: boolean
}

async function readWorkspaceAdapterType(storePath: string): Promise<WorkspaceMarkerState> {
  const markerPath = path.join(storePath, WORKSPACE_MARKER_FILE)
  let contents: string
  try {
    contents = await fsPromises.readFile(markerPath, 'utf8')
  } catch (error) {
    if ((error as { code?: string }).code === 'ENOENT') {
      return { adapterType: null, present: false }
    }
    // Do not guess the adapter when the marker cannot be read. Let the caller
    // fix the file and try again.
    throw unreadableMarkerError(markerPath, error)
  }
  const adapterType = parseWorkspaceMarker(contents)
  if (!adapterType) {
    logger.warn(
      `Unrecognized RAG workspace marker at ${markerPath}; detecting the adapter from the workspace layout`
    )
  }
  return { adapterType, present: true }
}

async function writeWorkspaceAdapterType(storePath: string, adapterType: RagAdapterType) {
  const markerPath = path.join(storePath, WORKSPACE_MARKER_FILE)
  const temporaryPath = `${markerPath}.tmp-${Date.now()}`
  const marker: RagWorkspaceMarker = {
    version: WORKSPACE_MARKER_VERSION,
    adapterType
  }
  await fsPromises.mkdir(storePath, { recursive: true })
  await fsPromises.writeFile(temporaryPath, `${JSON.stringify(marker)}\n`)
  await fsPromises.rename(temporaryPath, markerPath)
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
  const opening = openingWorkspaces.get(key)
  if (opening) {
    return opening
  }

  const attempt = openWorkspaceEntry(key).finally(() => {
    openingWorkspaces.delete(key)
  })
  openingWorkspaces.set(key, attempt)
  return attempt
}

async function openWorkspaceEntry(key: string) {
  const storePath = getStorePath(key)
  const workspaceExisted = fs.existsSync(storePath)
  const marker = await readWorkspaceAdapterType(storePath)
  const adapterType =
    marker.adapterType ??
    (workspaceExisted ? detectExistingAdapterType(key) : getRequestedAdapterType())
  const corestore = new Corestore(storePath)

  let dbAdapter: RagDbAdapter | undefined
  try {
    dbAdapter = createRagDbAdapter(corestore, key, adapterType, marker.adapterType !== null)
    if (!marker.present) await writeWorkspaceAdapterType(storePath, adapterType)
    await dbAdapter.ready()
  } catch (error) {
    if (dbAdapter) {
      try {
        await dbAdapter.close()
      } catch {
        // Keep the adapter initialization error as the primary failure.
      }
    }
    try {
      await corestore.close()
    } catch {
      // Keep the adapter initialization error as the primary failure.
    }
    if (!workspaceExisted && !ragWorkspaces.has(key)) {
      await deleteWorkspace(key)
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

  await Promise.all([
    fsPromises.rm(storePath, { recursive: true, force: true }),
    fsPromises.rm(indexPath, { recursive: true, force: true })
  ])

  return true
}
