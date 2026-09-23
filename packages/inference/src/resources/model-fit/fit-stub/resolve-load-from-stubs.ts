import fs from 'bare-fs'

import type { ModelSrcInput } from '@/schemas/index'
import type { CanonicalModelType } from '@/schemas/index'
import type { ResolveContext } from '@/schemas/plugin'
import { getPlugin } from '@/plugins/registry'
import { getRuntimeContext } from '@/runtime/state'
import {
  fetchFitStub,
  removeStub,
  type FitStubOptions,
  type FitStubUnavailableReason
} from '@/resources/model-fit/fit-stub/fetch-fit-stub'

export interface LoadDescription {
  /** Absent for the loads `loadModel` also takes without one. */
  modelSrc?: ModelSrcInput | undefined
  modelType: CanonicalModelType
  modelConfig?: Record<string, unknown> | undefined
}

export type ResolvedLoad = {
  status: 'resolved'
  modelPath: string
  modelConfig: unknown
  artifacts: Record<string, string>
  /** Removes every stub staged for this load. Never throws. */
  release: () => Promise<void>
}

export type LoadResolution =
  | ResolvedLoad
  | { status: 'no-stub'; reason: FitStubUnavailableReason; message?: string }
  | { status: 'unsupported-load'; detail: string }

function srcString(modelSrc: ModelSrcInput): string {
  return typeof modelSrc === 'string' ? modelSrc : modelSrc.src
}

/**
 * The stub ref a source carries, or `undefined` where it names no registry
 * artifact. A catalog constant carries the checksum and coordinates; a bare
 * string names a location and nothing the registry can be asked about.
 */
function stubRefFor(modelSrc: ModelSrcInput) {
  if (typeof modelSrc === 'string') return undefined
  const { sha256Checksum, registryPath, registrySource } = modelSrc
  if (sha256Checksum === undefined || registryPath === undefined) return undefined
  return {
    name: modelSrc.name ?? modelSrc.modelId ?? registryPath,
    sha256Checksum,
    registryPath,
    ...(registrySource !== undefined && { registrySource })
  }
}

class NoStubError extends Error {
  reason: FitStubUnavailableReason

  constructor(reason: FitStubUnavailableReason, message?: string) {
    super(message ?? reason)
    this.reason = reason
  }
}

/**
 * Resolves a load the way `loadModel` would, against the registry's weightless
 * descriptions instead of the weights.
 *
 * The plugin's own `resolveConfig` does the work: it strips the source fields
 * from the config and returns the artifact paths keyed the way its engine
 * expects. Only what a source resolves to differs here, so the config and the
 * keys are the real load's.
 *
 * A source already on disk is read directly, since it describes the load more
 * exactly than a stub does.
 */
export async function resolveLoadFromStubs(
  load: LoadDescription,
  options: FitStubOptions = {}
): Promise<LoadResolution> {
  const plugin = getPlugin(load.modelType)
  if (!plugin) {
    return { status: 'unsupported-load', detail: `no plugin registered for ${load.modelType}` }
  }

  const staged: string[] = []
  const release = async () => {
    for (const path of staged) await removeStub(path)
  }

  const resolveModelPath = async (src: ModelSrcInput): Promise<string> => {
    const location = srcString(src)
    if (location !== '' && fs.existsSync(location)) return location

    const ref = stubRefFor(src)
    if (ref === undefined) throw new NoStubError('unresolvable-ref', location)

    const stub = await fetchFitStub(ref, options)
    if (stub.status !== 'ready') throw new NoStubError(stub.reason, stub.message)

    staged.push(stub.path)
    return stub.path
  }

  try {
    const modelPath = load.modelSrc === undefined ? '' : await resolveModelPath(load.modelSrc)

    if (plugin.resolveConfig === undefined) {
      return {
        status: 'resolved',
        modelPath,
        modelConfig: load.modelConfig,
        artifacts: {},
        release
      }
    }

    const context: ResolveContext = {
      resolveModelPath,
      modelSrc: load.modelSrc === undefined ? '' : srcString(load.modelSrc),
      modelType: load.modelType,
      ...(getRuntimeContext().platform !== undefined && {
        platform: getRuntimeContext().platform
      })
    }

    const resolved = await plugin.resolveConfig(load.modelConfig ?? {}, context)

    return {
      status: 'resolved',
      modelPath,
      modelConfig: resolved.config,
      artifacts: (resolved.artifacts ?? {}) as Record<string, string>,
      release
    }
  } catch (error) {
    await release()
    if (error instanceof NoStubError) {
      return error.message === error.reason
        ? { status: 'no-stub', reason: error.reason }
        : { status: 'no-stub', reason: error.reason, message: error.message }
    }
    // A config the plugin refuses describes a load that would not start either.
    return {
      status: 'unsupported-load',
      detail: error instanceof Error ? `${error.name}: ${error.message}` : String(error)
    }
  }
}
