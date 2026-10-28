import type * as sdk from '@qvac/sdk'
import type { QvacContext } from '@/serve/core/context'
import {
  createMusicJobsStore,
  type MusicJob,
  type MusicJobKind,
  type MusicJobsStore
} from '@/serve/extensions/default/music-jobs-store'

export interface DefaultState {
  musicJobs: { [K in MusicJobKind]: MusicJobsStore<K> }
  /** Probed on the first encoded `/content` request, then reused. */
  ffmpegAvailable?: Promise<boolean>
  /** Test seams — override the SDK calls when set. */
  audioGenOverride?: typeof sdk.audioGen
  audioEditOverride?: typeof sdk.audioEdit
  audioUnderstandOverride?: typeof sdk.audioUnderstand
  cancelOverride?: typeof sdk.cancel
}

declare module '@/serve/core/context' {
  interface ServeExtensionState {
    default: DefaultState
  }
}

export function defaultState(ctx: QvacContext): DefaultState {
  const state = ctx.extensions.default
  if (state === undefined) {
    throw new Error('The default extension is not mounted.')
  }
  return state
}

export function createDefaultState(
  ctx: QvacContext,
  tearDown: (ctx: QvacContext, job: MusicJob) => void
): DefaultState {
  function store<K extends MusicJobKind>(kind: K): MusicJobsStore<K> {
    return createMusicJobsStore(kind, {
      onEvict: (job, reason) => {
        ctx.logger.warn(
          `audio ${kind} job evicted id=${job.id} reason=${reason} status=${job.status}`
        )
        tearDown(ctx, job)
      }
    })
  }
  return { musicJobs: { generation: store('generation'), edit: store('edit') } }
}

export function defaultBanners(state: DefaultState): string[] {
  const max = state.musicJobs.generation.maxEntries
  return [
    `audio generations/edits: in-memory only — job IDs and rendered audio are lost on restart, max ${max} entries each`
  ]
}
