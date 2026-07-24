import link from 'bare-link'
import { readFile, readdir, rm } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'

const appRoot = fileURLToPath(new URL('../', import.meta.url).href)
const nativeManifest = fileURLToPath(
  new URL('../generated/native-addons.json', import.meta.url).href
)
const addons = fileURLToPath(
  new URL(
    '../../../node_modules/react-native-bare-kit/android/src/main/addons/',
    import.meta.url
  ).href
)

await rm(addons, { recursive: true, force: true })

const addonPackages = readAddonPackages(
  JSON.parse(await readFile(nativeManifest, 'utf8'))
)
const pkg = {
  name: '@qvac-poc/task-mobile-addons',
  version: '0.0.0-poc',
  dependencies: Object.fromEntries(addonPackages.map((name) => [name, '*']))
}

const resources: string[] = []
for await (const resource of link(
  appRoot,
  {
    hosts: ['android-arm', 'android-arm64', 'android-ia32', 'android-x64'],
    out: addons
  },
  pkg
)) {
  const linked = String(resource)
  resources.push(linked)
  console.log(`linked ${linked}`)
}

if (resources.length === 0) {
  throw new Error('No Android native addon resources were linked')
}
const files = await readdir(addons, { recursive: true })
if (files.length === 0) {
  throw new Error('Android addon linker produced an empty addon directory')
}
console.log(
  `verified ${resources.length} linked Android addon resources for ${addonPackages.join(', ')}`
)

function readAddonPackages(value: unknown) {
  if (
    typeof value !== 'object' ||
    value === null ||
    !('packages' in value) ||
    !Array.isArray(value.packages) ||
    value.packages.length === 0 ||
    !value.packages.every((name) => typeof name === 'string' && name.length > 0)
  ) {
    throw new Error('Native addon manifest does not contain resolved packages')
  }
  return value.packages
}
