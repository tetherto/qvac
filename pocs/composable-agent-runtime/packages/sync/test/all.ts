import './local.ts'
import './replication.ts'
import './lifecycle.ts'
import './profile-protocol.ts'
import './public-api.ts'
import './worker-rpc.ts'
import './automatic-runtime.ts'
import './durable-work.ts'
import './mesh-control.ts'
import './argv-start-time.test.ts'

if (typeof Reflect.get(globalThis, 'Bare') === 'undefined') {
  await import('./react-native.test.ts')
  await import('./expo-plugin.test.ts')
}
