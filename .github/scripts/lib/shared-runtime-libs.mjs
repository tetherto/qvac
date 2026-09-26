// Libraries @qvac/inference shares with its addon peers at runtime. On 0.x,
// ranges that do not overlap install as separate copies and the Bare bundle
// carries both.
export const SHARED_RUNTIME_LIBS = [
  '@qvac/infer-base',
  '@qvac/logging',
  '@qvac/error',
]

// A consumer that installs the package together with every @qvac peer,
// optional or not, at the ranges the package declares. Other peers cannot
// bring in a shared lib. `overrides` maps package names to local specs.
export function buildConsumerManifest(pkg, packageSpec, overrides = {}) {
  const qvacPeers = Object.entries(pkg.peerDependencies ?? {}).filter(([name]) =>
    name.startsWith('@qvac/'),
  )
  const manifest = {
    name: 'shared-runtime-libs-check',
    version: '0.0.0',
    private: true,
    dependencies: {
      ...Object.fromEntries(qvacPeers),
      [pkg.name]: packageSpec,
    },
  }
  if (Object.keys(overrides).length > 0) manifest.overrides = overrides
  return manifest
}

function packageNameFromPath(path) {
  return path.slice(path.lastIndexOf('node_modules/') + 'node_modules/'.length)
}

function ownerOf(lockfile, path) {
  const index = path.lastIndexOf('/node_modules/')
  if (index === -1) return 'hoisted'
  const ownerPath = path.slice(0, index)
  const owner = lockfile.packages[ownerPath]
  const name = packageNameFromPath(ownerPath)
  return owner?.version ? `${name}@${owner.version}` : name
}

// Returns Map<lib, Map<version, owner[]>> from an npm v2/v3 lockfile.
export function collectResolvedVersions(lockfile, libs = SHARED_RUNTIME_LIBS) {
  if (!lockfile || typeof lockfile.packages !== 'object' || lockfile.lockfileVersion < 2) {
    throw new Error('expected an npm lockfile with lockfileVersion >= 2')
  }

  const resolved = new Map(libs.map((lib) => [lib, new Map()]))
  for (const [path, entry] of Object.entries(lockfile.packages)) {
    if (!path.includes('node_modules/')) continue
    const name = packageNameFromPath(path)
    const versions = resolved.get(name)
    if (!versions || !entry.version) continue
    const owners = versions.get(entry.version) ?? []
    owners.push(ownerOf(lockfile, path))
    versions.set(entry.version, owners)
  }
  return resolved
}

export function findDuplicates(resolved) {
  const duplicates = []
  for (const [lib, versions] of resolved) {
    if (versions.size > 1) {
      duplicates.push({
        lib,
        versions: [...versions].map(([version, owners]) => ({ version, owners })),
      })
    }
  }
  return duplicates
}

export function formatResolved(resolved) {
  return [...resolved].map(([lib, versions]) => {
    const list = versions.size ? [...versions.keys()].join(', ') : 'not installed'
    return `${lib}: ${list}`
  })
}

export function formatDuplicates(duplicates) {
  return duplicates.map(({ lib, versions }) => {
    const detail = versions
      .map(({ version, owners }) => `${version} (${owners.join(', ')})`)
      .join('; ')
    return `${lib} resolves to ${versions.length} versions: ${detail}`
  })
}
