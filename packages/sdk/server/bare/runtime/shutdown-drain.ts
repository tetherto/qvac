// Internal worker-shutdown helper. Not part of the package's export map, so it
// stays off the public `@qvac/sdk` surface while remaining unit-testable.

interface DrainableRegistry {
  cancelAll(reason: 'shutdown'): Promise<void>
  drainAll(): Promise<void>
}

/**
 * Cancel and drain every in-flight request, then release addon loggers/plugins.
 * The order is the contract: a still-draining request that logs must not route
 * through a freed native logger reference, so `releaseAddons` runs only after
 * the drain completes.
 */
export async function drainRequestsThenReleaseAddons(
  registry: DrainableRegistry,
  releaseAddons: () => void
): Promise<void> {
  await registry.cancelAll('shutdown')
  await registry.drainAll()
  releaseAddons()
}
