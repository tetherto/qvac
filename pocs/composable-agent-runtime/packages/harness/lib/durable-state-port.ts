import {
  durableWorkProfile,
  type DurableWorkCommand,
  type DurableWorkProfileContract,
  type DurableWorkQuery,
  type DurableWorkResult
} from './durable-work-profile.ts'

export type DurableStateWatchFrame =
  | {
      readonly kind: 'snapshot'
      readonly generation: string
      readonly cursor: string
      readonly value: DurableWorkResult
    }
  | {
      readonly kind: 'change'
      readonly generation: string
      readonly cursor: string
      readonly change: DurableWorkResult
    }

export interface DurableWorkProfileClient {
  apply(
    command: DurableWorkCommand,
    options: {
      readonly operationId: string
      readonly expectedRevision?: string
      readonly traceId?: string
    }
  ): Promise<{ readonly revision: string }>
  query(query: DurableWorkQuery): Promise<DurableWorkResult>
  watch(
    query: DurableWorkQuery,
    options?: {
      readonly after?: string
      readonly signal?: AbortSignal
    }
  ): AsyncIterable<DurableStateWatchFrame>
}

export interface DurableStatePort {
  openDurableWorkProfile(): DurableWorkProfileClient
}

interface DurableProfileRegistrySupplier {
  openProfile(profile: DurableWorkProfileContract): DurableWorkProfileClient
}

export type DurableStateInput =
  | DurableStatePort
  | DurableProfileRegistrySupplier

export function openDurableWorkProfile(
  state: DurableStateInput
): DurableWorkProfileClient {
  const client = hasDurableProfileOpener(state)
    ? state.openDurableWorkProfile()
    : state.openProfile(durableWorkProfile)
  assertDurableWorkProfileClient(client)
  return client
}

export function assertDurableStateInput(
  value: DurableStateInput
): asserts value is DurableStateInput {
  if (hasDurableProfileOpener(value) || hasProfileRegistry(value)) return
  throw new Error(
    'Harness durable state must provide openDurableWorkProfile() or a compatible profile registry'
  )
}

function hasDurableProfileOpener(
  value: DurableStateInput
): value is DurableStatePort {
  return typeof Reflect.get(value, 'openDurableWorkProfile') === 'function'
}

function hasProfileRegistry(
  value: DurableStateInput
): value is DurableProfileRegistrySupplier {
  return typeof Reflect.get(value, 'openProfile') === 'function'
}

function assertDurableWorkProfileClient(
  value: DurableWorkProfileClient
): asserts value is DurableWorkProfileClient {
  if (
    typeof Reflect.get(value, 'apply') === 'function' &&
    typeof Reflect.get(value, 'query') === 'function' &&
    typeof Reflect.get(value, 'watch') === 'function'
  ) {
    return
  }
  throw new Error('Harness durable state returned an invalid profile client')
}
