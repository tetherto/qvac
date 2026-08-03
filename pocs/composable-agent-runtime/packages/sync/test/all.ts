import './local.ts'
import './replication.ts'
import './argv-start-time.test.ts'

if (typeof Reflect.get(globalThis, 'Bare') === 'undefined') {
  await import('./react-native.test.ts')
  await import('./expo-plugin.test.ts')
}
