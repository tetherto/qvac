import { durableWorkRuntime } from './durable-work/reducer.ts'
import { ProfileRegistry } from './profile-runtime.ts'

export function createProfileRegistry() {
  const registry = new ProfileRegistry()
  registry.register(durableWorkRuntime)
  return registry
}
