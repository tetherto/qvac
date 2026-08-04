import type { WatchStream } from '../../spec/rpc/capabilities.d.ts'
import type {
  RpcEmpty,
  RpcProfileApplyRequest,
  RpcProfileApplyResult,
  RpcProfileQueryRequest,
  RpcProfileQueryResult,
  RpcProfileWatchFrame,
  RpcProfileWatchRequest,
  RpcRuntimeStatus
} from '../../spec/rpc/hyperschema/types.d.ts'
import { decodeProfileValue, encodeProfileValue } from './codec.ts'
import { toSyncError } from '../runtime/errors.ts'
import type {
  SyncProfileClient,
  SyncProfileContract,
  SyncWatchFrame
} from '../runtime/types.ts'

export type {
  SyncProfileClient,
  SyncProfileContract,
  SyncWatchFrame
} from '../runtime/types.ts'

export interface ProfileCalls {
  runtimeStatus(request: RpcEmpty): Promise<RpcRuntimeStatus>
  applyProfile(request: RpcProfileApplyRequest): Promise<RpcProfileApplyResult>
  queryProfile(request: RpcProfileQueryRequest): Promise<RpcProfileQueryResult>
  watchProfile(request: RpcProfileWatchRequest): WatchStream<RpcProfileWatchFrame>
}

export class ProfileClient<Command, Query, Result, Change = Result>
  implements SyncProfileClient<Command, Query, Result, Change>
{
  private readonly profile: SyncProfileContract<Command, Query, Result, Change>
  private readonly calls: ProfileCalls
  private readonly watches = new Set<WatchStream<RpcProfileWatchFrame>>()
  private readonly generation: Promise<string>
  private generationError: Error | null = null

  constructor(
    profile: SyncProfileContract<Command, Query, Result, Change>,
    calls: ProfileCalls
  ) {
    this.profile = profile
    this.calls = calls
    this.generation = calls.runtimeStatus({}).then((status) => status.generation)
  }

  async apply(
    command: Command,
    options: {
      readonly operationId: string
      readonly expectedRevision?: string
      readonly traceId?: string
    }
  ) {
    this.assertGeneration()
    if (!options.operationId.trim()) throw new Error('Profile operationId is required')
    const generation = await this.generation
    try {
      return await this.calls.applyProfile({
        profileId: this.profile.id,
        version: this.profile.version,
        generation,
        operationId: options.operationId,
        expectedRevision: options.expectedRevision,
        traceId: options.traceId,
        command: encodeProfileValue(command)
      })
    } catch (error) {
      throw toSyncError(error, {
        operationId: options.operationId,
        traceId: options.traceId
      })
    }
  }

  async query(query: Query) {
    this.assertGeneration()
    const generation = await this.generation
    try {
      const result = await this.calls.queryProfile({
        profileId: this.profile.id,
        version: this.profile.version,
        generation,
        query: encodeProfileValue(query)
      })
      return decodeProfileValue<Result>(result.value)
    } catch (error) {
      throw toSyncError(error)
    }
  }

  watch(
    query: Query,
    options: {
      readonly after?: string
      readonly signal?: AbortSignal
    } = {}
  ) {
    this.assertGeneration()
    const calls = this.calls
    const profile = this.profile
    const generationPromise = this.generation
    const watches = this.watches

    return (async function* () {
      const generation = await generationPromise
      const source = calls.watchProfile({
        profileId: profile.id,
        version: profile.version,
        generation,
        query: encodeProfileValue(query),
        after: options.after
      })
      const onError = () => {}
      source.on('error', onError)
      watches.add(source)
      const onAbort = () => source.destroy()
      options.signal?.addEventListener('abort', onAbort, { once: true })
      try {
        for await (const frame of source) {
          if (frame.kind === 'snapshot') {
            if (!frame.value) throw new Error('Profile snapshot is missing its value')
            yield {
              kind: 'snapshot' as const,
              generation: frame.generation,
              cursor: frame.cursor,
              value: decodeProfileValue<Result>(frame.value)
            }
            continue
          }
          if (!frame.change) throw new Error('Profile change is missing its value')
          yield {
            kind: 'change' as const,
            generation: frame.generation,
            cursor: frame.cursor,
            change: decodeProfileValue<Change>(frame.change)
          }
        }
      } catch (error) {
        throw toSyncError(error)
      } finally {
        options.signal?.removeEventListener('abort', onAbort)
        watches.delete(source)
        source.destroy()
      }
    })()
  }

  endWatches(error: Error) {
    for (const watch of this.watches) {
      Reflect.apply(watch.destroy, watch, [error])
    }
    this.watches.clear()
  }

  endGeneration(error: Error) {
    this.generationError = error
    this.endWatches(error)
  }

  private assertGeneration() {
    if (this.generationError) throw this.generationError
  }
}
