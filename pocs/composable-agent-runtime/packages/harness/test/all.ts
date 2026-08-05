import './harness.test.ts'
import './brokered-agent.test.ts'
import './wire.test.ts'
import './child-entry.test.ts'
import './in-memory-harness-run-store.test.ts'
import './config.test.ts'

if (typeof Reflect.get(globalThis, 'Bare') === 'undefined') {
  await import('./react-native.test.ts')
  await import('./expo-plugin.test.ts')
}
