export const FABRIC = '@qvac/fabric'

// The @qvac/* packages the SDK depends on directly: the addon set it selects.
export function sdkQvacDependencies(pkg) {
  return Object.keys({ ...pkg.dependencies, ...pkg.optionalDependencies })
    .filter((name) => name.startsWith('@qvac/'))
    .sort()
}

function parentDir(path) {
  const index = path.lastIndexOf('node_modules/')
  return index <= 0 ? '' : path.slice(0, index - 1)
}

// Node-style lookup: <from>/node_modules/<name>, then each ancestor up to the root.
function resolveFrom(lockfile, from, name) {
  let dir = from
  for (;;) {
    const path = dir ? `${dir}/node_modules/${name}` : `node_modules/${name}`
    if (lockfile.packages[path]) return path
    if (!dir) return null
    dir = parentDir(dir)
  }
}

// For each SDK dependency that declares @qvac/fabric: the version npm selects,
// the fabric range it declares, and the fabric version that range resolves to.
export function collectAddonFabric(lockfile, sdkName, dependencies) {
  if (!lockfile || typeof lockfile.packages !== 'object' || lockfile.lockfileVersion < 2) {
    throw new Error('expected an npm lockfile with lockfileVersion >= 2')
  }
  const sdkPath = resolveFrom(lockfile, '', sdkName)
  if (!sdkPath) throw new Error(`${sdkName} is not in the lockfile`)

  const addons = []
  for (const name of dependencies) {
    const path = resolveFrom(lockfile, sdkPath, name)
    if (!path) throw new Error(`${name} is not in the lockfile`)
    const entry = lockfile.packages[path]
    const range = entry.dependencies?.[FABRIC] ?? entry.peerDependencies?.[FABRIC]
    if (!range) continue

    const fabricPath = resolveFrom(lockfile, path, FABRIC)
    const fabric = fabricPath && lockfile.packages[fabricPath].version
    if (!fabric) throw new Error(`${name}@${entry.version} declares ${FABRIC} ${range}, but it did not resolve`)
    addons.push({ name, version: entry.version, range, fabric })
  }
  return addons
}

// Returns [] when every addon resolves the same fabric, else one group per version.
export function findFabricConflict(addons) {
  const byFabric = new Map()
  for (const addon of addons) {
    const group = byFabric.get(addon.fabric) ?? []
    group.push(addon)
    byFabric.set(addon.fabric, group)
  }
  if (byFabric.size <= 1) return []
  return [...byFabric].map(([fabric, group]) => ({ fabric, addons: group }))
}

export function formatAddon({ name, version, range, fabric }) {
  return `${name}@${version} -> ${FABRIC} ${range} (${fabric})`
}

export function formatConflict(conflict) {
  return conflict.map(({ fabric, addons }) => {
    const list = addons.map(({ name, version, range }) => `${name}@${version} (${range})`).join(', ')
    return `${FABRIC} ${fabric}: ${list}`
  })
}
