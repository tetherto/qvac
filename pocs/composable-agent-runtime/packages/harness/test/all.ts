import './harness.test.ts'
import './wire.test.ts'
import './child-entry.test.ts'
import './in-memory-agent-state-store.test.ts'

if (typeof Reflect.get(globalThis, 'Bare') === 'undefined') {
  await import('./react-native.test.ts')
  await import('./expo-plugin.test.ts')
}
