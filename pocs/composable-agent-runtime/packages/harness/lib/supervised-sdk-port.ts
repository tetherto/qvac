import { RuntimeComponentExitedError } from '@qvac/runtime-contracts'
import { Supervisor } from '@qvac/supervisor'
import type { SdkRuntimePort } from './sdk-runtime-port.ts'

export function createSupervisedSdkPort(createSdk: () => Promise<SdkRuntimePort>): SdkRuntimePort {
  const supervisor = new Supervisor()
  let ready: Promise<void> | null = null

  async function sdk() {
    ready ??= (async () => {
      supervisor.add('sdk', {
        restart: 'always',
        async start(context) {
          const runtime = await createSdk()
          runtime.exited?.then((exit) => {
            context.onDeath(
              new RuntimeComponentExitedError('sdk', exit)
            )
          }, context.onDeath)
          return runtime
        },
        stop: (runtime) => runtime.close(),
        inspect: () => ({ boundary: 'SdkRuntimePort' })
      })
      await supervisor.ready()
    })()
    await ready
    return supervisor.get<SdkRuntimePort>('sdk')
  }

  return {
    async loadModel(input) {
      return (await sdk()).loadModel(input)
    },
    completion(input) {
      let requestId = input.requestId
      return {
        get requestId() {
          return requestId
        },
        events: (async function* () {
          const run = (await sdk()).completion(input)
          requestId = run.requestId
          yield* run.events
        })()
      }
    },
    async cancel(input) {
      await (await sdk()).cancel(input)
    },
    async heartbeat() {
      return (await sdk()).heartbeat()
    },
    async close() {
      await supervisor.close()
    }
  }
}
