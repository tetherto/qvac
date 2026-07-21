import link from 'bare-link'
import { rm } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'

const appRoot = fileURLToPath(new URL('../', import.meta.url).href)
const addons = fileURLToPath(
  new URL('../../../node_modules/react-native-bare-kit/ios/addons/', import.meta.url)
    .href
)

await rm(addons, { recursive: true, force: true })

const pkg = {
  name: '@qvac-poc/task-mobile-addons',
  version: '0.0.0-poc',
  dependencies: {
    'bare-abort': '*'
  }
}

for await (const resource of link(
  appRoot,
  {
    hosts: ['ios-arm64', 'ios-arm64-simulator', 'ios-x64-simulator'],
    out: addons
  },
  pkg
)) {
  console.log(`linked ${String(resource)}`)
}
