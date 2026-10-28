import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod'
import type { z } from 'zod'
import {
  getLoadedModelInfo,
  resume,
  state,
  suspend,
  type LifecycleState,
  type LoadedModelInfo
} from '@qvac/sdk'
import { HttpError } from '@/serve/lib/http-error'
import { errorResponses } from '@/serve/lib/error-responses'
import {
  runtimeModelsResult,
  runtimeState,
  type RuntimeModel
} from '@/serve/extensions/default/schemas/runtime'

const ADMIN_DISABLED = {
  admin_disabled: 'The server was started without `--enable-admin`'
}

const SUSPENDED = {
  runtime_suspended: 'The runtime is not active; resume it first'
}

const descriptions = {
  state: `
Read the runtime lifecycle state, backed by the SDK's \`state()\`. Answers
while the runtime is suspended.

\`active\` serves every request. While \`suspending\`, \`suspended\` or
\`resuming\`, every other route answers \`503 runtime_suspended\`.
`.trim(),
  models: `
List the \`serve.models\` aliases whose model is loaded, with the SDK's
\`getLoadedModelInfo()\` for each. Aliases that are configured but not loaded
are left out; \`/v1/models\` lists those.
`.trim(),
  suspend: `
Suspend the runtime, backed by the SDK's \`suspend()\`. **Admin-only:** needs
\`--enable-admin\`.

P2P resources pause and every route except this group answers
\`503 runtime_suspended\` until \`POST /qvac/v1/runtime/resume\`. Requests
already running finish. Idempotent.

When a resource fails to pause the runtime is still suspended, and the error
says so; resume is the recovery path.
`.trim(),
  resume: `
Resume the runtime, backed by the SDK's \`resume()\`. **Admin-only:** needs
\`--enable-admin\`. Idempotent.

When a resource fails to restore the runtime stays suspended; retry.
`.trim()
}

export interface RuntimeOperations {
  state: () => Promise<LifecycleState>
  suspend: () => Promise<void>
  resume: () => Promise<void>
  getLoadedModelInfo: (params: { modelId: string }) => Promise<LoadedModelInfo>
}

const SDK_OPERATIONS: RuntimeOperations = { state, suspend, resume, getLoadedModelInfo }

export function runtimeRoutes(ops: RuntimeOperations = SDK_OPERATIONS): FastifyPluginAsyncZod {
  // lunte-disable-next-line require-await
  return async (app) => {
    const { qvac } = app

    async function readState(): Promise<LifecycleState> {
      try {
        qvac.runtime.state = await ops.state()
      } catch (err) {
        qvac.logger.error(`  runtime state failed: ${errorMessage(err)}`)
        throw new HttpError(500, 'runtime_state_failed', 'Failed to read the runtime state.')
      }
      return qvac.runtime.state
    }

    // The SDK settles on a state even when a transition fails, so re-read it
    // before reporting the failure and keep the request gate in step.
    async function transition(
      run: () => Promise<void>,
      failure: { code: string; message: string }
    ): Promise<z.infer<typeof runtimeState>> {
      try {
        await run()
      } catch (err) {
        qvac.logger.error(`  runtime ${failure.code}: ${errorMessage(err)}`)
        await readState().catch(() => {})
        throw new HttpError(500, failure.code, failure.message)
      }
      return { object: 'runtime.state' as const, state: await readState() }
    }

    app.get(
      '/qvac/v1/runtime/state',
      {
        config: { allowWhileSuspended: true },
        schema: {
          response: {
            200: runtimeState,
            ...errorResponses({
              500: { runtime_state_failed: 'The SDK could not report the lifecycle state' }
            })
          },
          tags: ['Runtime'],
          summary: 'Read the runtime state',
          description: descriptions.state
        }
      },
      async () => ({ object: 'runtime.state' as const, state: await readState() })
    )

    app.get(
      '/qvac/v1/runtime/models',
      {
        schema: {
          response: {
            200: runtimeModelsResult,
            ...errorResponses({
              503: SUSPENDED,
              500: { runtime_query_failed: 'The SDK could not describe a loaded model' }
            })
          },
          tags: ['Runtime'],
          summary: 'List loaded models',
          description: descriptions.models
        }
      },
      async () => {
        const ready = qvac.registry
          .entries()
          .filter((e) => e.state === qvac.registry.STATES.READY && e.sdkModelId !== null)
        const rows = await Promise.all(
          ready.map(async (entry) => {
            try {
              return toRow(entry.id, await ops.getLoadedModelInfo({ modelId: entry.sdkModelId! }))
            } catch (err) {
              // Unloaded between the registry read and the SDK call.
              if (qvac.registry.getEntry(entry.id)?.state !== qvac.registry.STATES.READY) {
                return null
              }
              qvac.logger.error(`  runtime model ${entry.id} failed: ${errorMessage(err)}`)
              throw new HttpError(500, 'runtime_query_failed', 'Failed to describe a loaded model.')
            }
          })
        )
        return { object: 'list' as const, data: rows.filter((row) => row !== null) }
      }
    )

    app.post(
      '/qvac/v1/runtime/suspend',
      {
        config: { admin: true, allowWhileSuspended: true },
        schema: {
          response: {
            200: runtimeState,
            ...errorResponses({
              403: ADMIN_DISABLED,
              500: {
                runtime_suspend_failed:
                  'A resource failed to pause; the runtime is suspended anyway'
              }
            })
          },
          tags: ['Runtime'],
          summary: 'Suspend the runtime',
          description: descriptions.suspend
        }
      },
      () =>
        transition(ops.suspend, {
          code: 'runtime_suspend_failed',
          message:
            'Failed to pause every runtime resource. The runtime is suspended; POST /qvac/v1/runtime/resume to recover.'
        })
    )

    app.post(
      '/qvac/v1/runtime/resume',
      {
        config: { admin: true, allowWhileSuspended: true },
        schema: {
          response: {
            200: runtimeState,
            ...errorResponses({
              403: ADMIN_DISABLED,
              500: {
                runtime_resume_failed: 'A resource failed to restore; the runtime stays suspended'
              }
            })
          },
          tags: ['Runtime'],
          summary: 'Resume the runtime',
          description: descriptions.resume
        }
      },
      () =>
        transition(ops.resume, {
          code: 'runtime_resume_failed',
          message:
            'Failed to restore every runtime resource. The runtime is still suspended; retry.'
        })
    )
  }
}

function toRow(alias: string, info: LoadedModelInfo): RuntimeModel {
  return {
    object: 'runtime.model',
    model: alias,
    modelId: info.modelId,
    modelType: info.modelType,
    handlers: info.handlers,
    ...(info.displayName !== undefined && { displayName: info.displayName }),
    ...(info.addonPackage !== undefined && { addonPackage: info.addonPackage }),
    ...(info.name !== undefined && { name: info.name }),
    loadedAt: new Date(info.loadedAt).getTime()
  }
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

export default runtimeRoutes()
