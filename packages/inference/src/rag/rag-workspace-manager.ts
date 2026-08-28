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
import fs, { promises as fsPromises } from 'bare-fs'
import path from 'bare-path'
import { getEnv } from '@/runtime/env'
import { getConfiguredCacheDir } from '@/runtime/state'
import {
  PathTraversalError,
  RAGWorkspaceInUseError,
  RAGWorkspaceModelMismatchError,
  RAGWorkspaceNotOpenError
} from '@/errors/index'
import { validateAndJoinPath } from '@/utils/path-security'
import { createStreamLogger, getEngineLogger, RAG_NAMESPACE } from '@/logging/index'
import { cancelAllRagOperations } from '@/rag/rag-operation-manager'
import { registerCorestore, unregisterCorestore } from '@/runtime/runtime-lifecycle'
import { getTurboVecIndexProvider } from '@/plugins/registry'

const logger = getEngineLogger()
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
let isCleaningUp = false

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

function getWorkspacePath(basePath: string, workspace: string) {
  const workspacePath = validateAndJoinPath(basePath, workspace)
  if (workspacePath === path.resolve(basePath)) {
    throw new PathTraversalError(workspace, basePath)
  }
  return workspacePath
}

function getStorePath(workspace: string) {
  return getWorkspacePath(getRagBaseDir(), workspace)
}

function getIndexPath(workspace: string) {
  return getWorkspacePath(getRagIndexBaseDir(), workspace)
}

async function createWorkspaceDirectory(directoryPath: string) {
  await fsPromises.mkdir(path.dirname(directoryPath), { recursive: true })
  try {
    await fsPromises.mkdir(directoryPath)
    return true
  } catch (error) {
    if ((error as { code?: string }).code === 'EEXIST') return false
    throw error
  }
}

async function cleanupCreatedWorkspacePaths(
  storePath: string,
  indexPath: string,
  createdStore: boolean,
  createdIndex: boolean
) {
  const removals: Array<Promise<void>> = []
  if (createdStore) removals.push(fsPromises.rm(storePath, { recursive: true, force: true }))
  if (createdIndex) removals.push(fsPromises.rm(indexPath, { recursive: true, force: true }))
  await Promise.all(removals)
}

function missingIndexProviderError(workspace: string) {
  return new QvacErrorRAG({
    code: ERR_CODES.DEPENDENCY_REQUIRED,
    adds: `RAG workspace '${workspace}' needs a TurboVec index provider; register a plugin that exposes the turbovecIndexProvider capability`
  })
}

// A pinned workspace scans HyperDB while its plugin is missing. If a plugin is
// registered later, the next create/load attempt (for example, reindex/reopen)
// uses it; existing searches do not switch providers automatically.
function createUnavailableIndexProvider(workspace: string): TurboVecIndexProvider {
  return {
    create(options) {
      const indexProvider = getTurboVecIndexProvider()
      if (indexProvider) return indexProvider.create(options)
      throw missingIndexProviderError(workspace)
    },
    load(snapshotPath) {
      const indexProvider = getTurboVecIndexProvider()
      if (indexProvider) return indexProvider.load(snapshotPath)
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
  const rolloutFlag = getEnv().QVAC_RAG_TURBOVEC
  if (rolloutFlag && rolloutFlag !== '0' && rolloutFlag !== '1') {
    logger.warn(
      `Ignoring unrecognized QVAC_RAG_TURBOVEC value '${rolloutFlag}'; set it to '1' to enable TurboVec for new workspaces`
    )
  }
  return rolloutFlag === '1' ? 'turbovec' : 'hyperdb'
}

function unreadableMarkerError(markerPath: string, cause: unknown) {
  return new QvacErrorRAG({
    code: ERR_CODES.DB_OPERATION_FAILED,
    adds: `RAG workspace adapter marker could not be read (${markerPath}); retry once the file is accessible`,
    cause: cause instanceof Error ? cause : undefined
  })
}

function parseWorkspaceMarker(contents: string): RagAdapterType | null {
  let marker: Partial<RagWorkspaceMarker> | null
  try {
    marker = JSON.parse(contents) as Partial<RagWorkspaceMarker> | null
  } catch {
    return null
  }
  if (marker === null || typeof marker !== 'object' || Array.isArray(marker)) return null
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
  const indexPath = getIndexPath(key)
  let createdStore = false
  let createdIndex = false
  let corestore: Corestore | undefined

  let dbAdapter: RagDbAdapter | undefined
  try {
    createdStore = await createWorkspaceDirectory(storePath)
    const marker = await readWorkspaceAdapterType(storePath)
    const adapterType =
      marker.adapterType ??
      (createdStore ? getRequestedAdapterType() : detectExistingAdapterType(key))
    if (adapterType === 'turbovec') {
      createdIndex = await createWorkspaceDirectory(indexPath)
    }
    corestore = new Corestore(storePath)
    const isPinned = marker.adapterType !== null || !createdStore
    dbAdapter = createRagDbAdapter(corestore, key, adapterType, isPinned)
    await dbAdapter.ready()
    if (!marker.present) {
      try {
        await writeWorkspaceAdapterType(storePath, adapterType)
      } catch (error) {
        if (createdStore) throw error
        logger.warn(
          `Failed to write the RAG workspace adapter marker for existing workspace '${key}'; continuing without it:`,
          error
        )
      }
    }
  } catch (error) {
    if (dbAdapter) {
      try {
        await dbAdapter.close()
      } catch {
        // Keep the adapter initialization error as the primary failure.
      }
    }
    if (corestore) {
      try {
        await corestore.close()
      } catch {
        // Keep the adapter initialization error as the primary failure.
      }
    }
    try {
      await cleanupCreatedWorkspacePaths(storePath, indexPath, createdStore, createdIndex)
    } catch (cleanupError) {
      logger.warn(`Failed to clean up newly created RAG workspace '${key}':`, cleanupError)
    }
    throw error
  }

  if (isCleaningUp) {
    let closeError: Error | undefined
    try {
      await dbAdapter.close()
    } catch (error) {
      if (error instanceof Error) closeError = error
    }
    try {
      await corestore.close()
    } catch (error) {
      if (!closeError && error instanceof Error) closeError = error
    }
    throw new QvacErrorRAG({
      code: ERR_CODES.DB_OPERATION_FAILED,
      adds: `RAG workspace '${key}' open was cancelled during cleanup`,
      cause: closeError
    })
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

const OPEN_SETTLE_TIMEOUT_MS = 10_000

async function waitForSettledOpen(key: string, opening: Promise<unknown>) {
  const settled = opening.then(
    () => true,
    () => true
  )
  let timer: ReturnType<typeof setTimeout> | undefined
  const timedOut = new Promise<boolean>((resolve) => {
    timer = setTimeout(() => resolve(false), OPEN_SETTLE_TIMEOUT_MS)
  })
  const didSettle = await Promise.race([settled, timedOut])
  if (timer !== undefined) clearTimeout(timer)
  if (!didSettle) {
    logger.warn(
      `Abandoned the in-flight open of RAG workspace '${key}' after ${OPEN_SETTLE_TIMEOUT_MS}ms`
    )
  }
}

export async function closeRagInstance(workspace?: string) {
  const key = getWorkspaceKey(workspace)
  const opening = openingWorkspaces.get(key)
  if (opening) {
    await waitForSettledOpen(key, opening)
  }
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

export async function closeAllRagInstances() {
  if (isCleaningUp) return
  isCleaningUp = true

  try {
    cancelAllRagOperations()

    const openingAttempts = Array.from(openingWorkspaces.entries())
    await Promise.all(openingAttempts.map(([key, attempt]) => waitForSettledOpen(key, attempt)))

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
  return ragWorkspaces.has(key) || openingWorkspaces.has(key)
}

export async function deleteWorkspace(workspace: string) {
  const key = getWorkspaceKey(workspace)
  const storePath = getStorePath(key)
  const indexPath = getIndexPath(key)

  if (isWorkspaceLoaded(key)) {
    throw new RAGWorkspaceInUseError(key)
  }

  if (!fs.existsSync(storePath) && !fs.existsSync(indexPath)) {
    return false
  }

  await Promise.all([
    fsPromises.rm(storePath, { recursive: true, force: true }),
    fsPromises.rm(indexPath, { recursive: true, force: true })
  ])

  return true
}
