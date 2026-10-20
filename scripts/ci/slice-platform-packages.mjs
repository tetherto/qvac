import fs from 'node:fs'
import path from 'node:path'
import process from 'node:process'
import { pathToFileURL } from 'node:url'

export const SLICE_DEFINITIONS = [
  { suffix: 'linux-x64', hosts: ['linux-x64'], os: ['linux'], cpu: ['x64'], libc: ['glibc'] },
  { suffix: 'linux-arm64', hosts: ['linux-arm64'], os: ['linux'], cpu: ['arm64'], libc: ['glibc'] },
  { suffix: 'darwin-arm64', hosts: ['darwin-arm64'], os: ['darwin'], cpu: ['arm64'] },
  { suffix: 'darwin-x64', hosts: ['darwin-x64'], os: ['darwin'], cpu: ['x64'] },
  { suffix: 'win32-x64', hosts: ['win32-x64'], os: ['win32'], cpu: ['x64'] },
  { suffix: 'android-arm64', hosts: ['android-arm64'], crossBuilt: true },
  { suffix: 'ios', hosts: ['ios-arm64', 'ios-arm64-simulator', 'ios-x64-simulator'], crossBuilt: true }
]

// A platform package is an ordinary Bare addon: require.addon() resolves its
// own prebuilds/<host>/<mangled package name>.bare, a literal call that
// bare-pack and bare-link follow. The meta's binding.js is just
// `module.exports = require('#host-addon')`, mapped to these packages.
export const PLATFORM_INDEX_SOURCE = 'module.exports = require.addon()\n'

const DEFAULT_MAX_SLICE_MB = 450
const BYTES_PER_MB = 1024 * 1024
const MANIFEST_INDENT = 2
const META_FILES_TO_COPY = ['LICENSE', 'NOTICE']
const BARE_ADDON_EXTENSION = '.bare'

export function hostToSliceSuffix (host) {
  const definition = SLICE_DEFINITIONS.find((slice) => slice.hosts.includes(host))
  return definition ? definition.suffix : null
}

export function slicePackageName (metaName, definition) {
  return metaName + '-' + definition.suffix
}

// Bare's mangling of a package name into an addon file name (cmake-bare's
// bare_module_target, bare-addon-resolve): drop the @, / becomes __.
export function mangledAddonName (packageName) {
  return packageName.replace(/^@/, '').replace('/', '__')
}

// The file require.addon() in the platform package loads on `host`; the
// native build must name its module after the platform package
// (add_bare_module(... NAME <mangled name>)) for this to exist.
export function expectedAddonFile (metaName, host) {
  const definition = SLICE_DEFINITIONS.find((slice) => slice.hosts.includes(host))
  if (!definition) throw new Error('No slice mapping for host ' + host)
  return mangledAddonName(slicePackageName(metaName, definition)) + BARE_ADDON_EXTENSION
}

export function validateHostDirs (hostDirs) {
  const known = new Set(collectKnownHosts())
  const unknown = hostDirs.filter((host) => !known.has(host))
  if (unknown.length > 0) {
    throw new Error(
      'Unknown prebuild host dirs with no slice mapping: ' + unknown.join(', ') +
      '. Add them to SLICE_DEFINITIONS in scripts/ci/slice-platform-packages.mjs.'
    )
  }
  const missing = [...known].filter((host) => !hostDirs.includes(host))
  if (missing.length > 0) {
    throw new Error(
      'Merged prebuilds artifact is missing host dirs: ' + missing.join(', ') +
      '. Refusing to publish an incomplete release.'
    )
  }
}

function assertHostAddonPresent (prebuildsDir, metaName, host) {
  const expected = expectedAddonFile(metaName, host)
  const entries = fs.readdirSync(path.join(prebuildsDir, host))
  const addons = entries.filter((entry) => entry.endsWith(BARE_ADDON_EXTENSION))
  if (addons.length === 0) {
    throw new Error(
      'No ' + BARE_ADDON_EXTENSION + ' addon under prebuilds/' + host +
      '. Refusing to publish a binary-less platform package.'
    )
  }
  if (!addons.includes(expected)) {
    throw new Error(
      'prebuilds/' + host + ' carries ' + addons.join(', ') + ' but not ' + expected +
      ', the only file require.addon() in the platform package loads. Build the ' +
      'module with add_bare_module(... NAME ' + expected.slice(0, -BARE_ADDON_EXTENSION.length) + ').'
    )
  }
}

function assertAllHostAddonsPresent (prebuildsDir, metaName) {
  for (const host of collectKnownHosts()) {
    assertHostAddonPresent(prebuildsDir, metaName, host)
  }
}

function collectKnownHosts () {
  const hosts = []
  for (const definition of SLICE_DEFINITIONS) {
    hosts.push(...definition.hosts)
  }
  return hosts
}

export function buildSliceManifest (metaManifest, definition) {
  const manifest = {
    name: slicePackageName(metaManifest.name, definition),
    version: metaManifest.version,
    description: 'Prebuilt ' + definition.suffix + ' binaries for ' + metaManifest.name,
    main: 'index.js',
    exports: {
      '.': './index.js',
      './package': './package.json'
    },
    addon: true,
    files: ['index.js', 'prebuilds', 'NOTICE'],
    repository: metaManifest.repository,
    author: metaManifest.author,
    license: metaManifest.license,
    bugs: metaManifest.bugs,
    homepage: metaManifest.homepage,
    engines: metaManifest.engines
  }
  if (definition.os) manifest.os = definition.os
  if (definition.cpu) manifest.cpu = definition.cpu
  if (definition.libc) manifest.libc = definition.libc
  return manifest
}

export function buildSliceReadme (metaManifest, definition) {
  return '# ' + metaManifest.name + '-' + definition.suffix + '\n\n' +
    'Prebuilt ' + definition.suffix + ' binaries for [' + metaManifest.name +
    '](https://www.npmjs.com/package/' + metaManifest.name + ').\n\n' +
    buildSliceReadmeUsage(metaManifest, definition)
}

function buildSliceReadmeUsage (metaManifest, definition) {
  if (definition.crossBuilt) {
    return 'This target is cross-built: no install host ever reports its platform, so\n' +
      '`os`/`cpu` filtered optional dependencies can never select it. Applications\n' +
      'targeting ' + definition.suffix + ' must depend on this package directly,\n' +
      'pinned to the exact ' + metaManifest.name + ' version.\n'
  }
  return 'Do not depend on this package directly. Install ' + metaManifest.name +
    ' instead; package managers that support `os`/`cpu` filtered optional\n' +
    'dependencies (npm 7+, pnpm, bun, Yarn Berry) select the right platform\n' +
    'package automatically.\n'
}

export function buildOptionalDependencies (metaManifest, definitions) {
  const optionalDependencies = {}
  for (const definition of selectHostFilteredDefinitions(definitions)) {
    optionalDependencies[slicePackageName(metaManifest.name, definition)] = metaManifest.version
  }
  return optionalDependencies
}

// Cross-built slices are declared as optional peers: nothing installs them
// for the app, but tools that walk declared dependencies (bare-link 3 under
// react-native-bare-kit, bare-pack's resolver) see the edge from the meta to
// whichever one the app installed.
export function buildCrossBuiltPeers (metaManifest, definitions) {
  const peerDependencies = {}
  const peerDependenciesMeta = {}
  for (const definition of definitions.filter((d) => d.crossBuilt)) {
    const name = slicePackageName(metaManifest.name, definition)
    peerDependencies[name] = metaManifest.version
    peerDependenciesMeta[name] = { optional: true }
  }
  return { peerDependencies, peerDependenciesMeta }
}

function selectHostFilteredDefinitions (definitions) {
  return definitions.filter((definition) => !definition.crossBuilt)
}

function readManifest (manifestPath) {
  return JSON.parse(fs.readFileSync(manifestPath, 'utf8'))
}

function writeManifest (manifestPath, manifest) {
  fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, MANIFEST_INDENT) + '\n')
}

function listHostDirs (prebuildsDir, keepDirs) {
  if (!fs.existsSync(prebuildsDir)) {
    throw new Error('No prebuilds directory at ' + prebuildsDir)
  }
  return fs
    .readdirSync(prebuildsDir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && !keepDirs.includes(entry.name))
    .map((entry) => entry.name)
    .sort()
}

// A kept dir is part of what the meta ships (fabric's C++ SDK under include/
// and share/), so publishing without it is as broken as a binary-less slice.
function assertKeepDirsPresent (prebuildsDir, keepDirs) {
  const missing = keepDirs.filter((dir) => {
    const dirPath = path.join(prebuildsDir, dir)
    return !fs.existsSync(dirPath) || !fs.statSync(dirPath).isDirectory()
  })
  if (missing.length > 0) {
    throw new Error(
      'Merged prebuilds artifact is missing the meta package dirs: ' + missing.join(', ') +
      '. Refusing to publish a meta package without them.'
    )
  }
}

function sliceDirName (metaManifest, definition) {
  return metaManifest.name.replace('@', '').replace('/', '-') + '-' + definition.suffix
}

function stageSlice (definition, context) {
  const { metaManifest, workdir, outDir, prebuildsDir } = context
  const sliceDir = path.join(outDir, sliceDirName(metaManifest, definition))
  const slicePrebuildsDir = path.join(sliceDir, 'prebuilds')
  fs.mkdirSync(slicePrebuildsDir, { recursive: true })

  writeManifest(path.join(sliceDir, 'package.json'), buildSliceManifest(metaManifest, definition))
  fs.writeFileSync(path.join(sliceDir, 'index.js'), PLATFORM_INDEX_SOURCE)
  fs.writeFileSync(path.join(sliceDir, 'README.md'), buildSliceReadme(metaManifest, definition))
  copyMetaFiles(workdir, sliceDir)
  moveHostDirs(definition.hosts, prebuildsDir, slicePrebuildsDir)

  return sliceDir
}

function copyMetaFiles (workdir, sliceDir) {
  for (const fileName of META_FILES_TO_COPY) {
    const source = path.join(workdir, fileName)
    if (fs.existsSync(source)) {
      fs.copyFileSync(source, path.join(sliceDir, fileName))
    }
  }
}

function moveHostDirs (hosts, prebuildsDir, slicePrebuildsDir) {
  for (const host of hosts) {
    fs.renameSync(path.join(prebuildsDir, host), path.join(slicePrebuildsDir, host))
  }
}

function removeEmptiedPrebuildsDir (prebuildsDir, keepDirs) {
  const leftovers = fs.readdirSync(prebuildsDir).filter((entry) => !keepDirs.includes(entry))
  if (leftovers.length > 0) {
    throw new Error('Unexpected leftover entries under ' + prebuildsDir + ': ' + leftovers.join(', '))
  }
  if (keepDirs.length === 0) fs.rmdirSync(prebuildsDir)
}

function directorySizeBytes (dir) {
  let total = 0
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const entryPath = path.join(dir, entry.name)
    total += entry.isDirectory() ? directorySizeBytes(entryPath) : fs.statSync(entryPath).size
  }
  return total
}

function assertSliceSize (sliceDir, maxSliceMb) {
  const sizeMb = directorySizeBytes(sliceDir) / BYTES_PER_MB
  if (sizeMb > maxSliceMb) {
    throw new Error(
      path.basename(sliceDir) + ' unpacked size ' + sizeMb.toFixed(1) +
      ' MB exceeds the ' + maxSliceMb + ' MB budget'
    )
  }
  return sizeMb
}

export function slicePlatformPackages (options) {
  const { workdir, outDir, maxSliceMb = DEFAULT_MAX_SLICE_MB, keepDirs = [], log = () => {} } = options
  const metaManifestPath = path.join(workdir, 'package.json')
  const metaManifest = readManifest(metaManifestPath)
  const prebuildsDir = path.join(workdir, 'prebuilds')

  validateHostDirs(listHostDirs(prebuildsDir, keepDirs))
  assertAllHostAddonsPresent(prebuildsDir, metaManifest.name)
  assertKeepDirsPresent(prebuildsDir, keepDirs)
  fs.mkdirSync(outDir, { recursive: true })

  const context = { metaManifest, workdir, outDir, prebuildsDir }
  const sliceDirs = stageAllSlices(context, maxSliceMb, log)

  removeEmptiedPrebuildsDir(prebuildsDir, keepDirs)
  metaManifest.optionalDependencies = buildOptionalDependencies(metaManifest, SLICE_DEFINITIONS)
  const { peerDependencies, peerDependenciesMeta } = buildCrossBuiltPeers(metaManifest, SLICE_DEFINITIONS)
  metaManifest.peerDependencies = { ...metaManifest.peerDependencies, ...peerDependencies }
  metaManifest.peerDependenciesMeta = { ...metaManifest.peerDependenciesMeta, ...peerDependenciesMeta }
  writeManifest(metaManifestPath, metaManifest)
  log(
    'Injected ' + Object.keys(metaManifest.optionalDependencies).length +
    ' host-filtered optionalDependencies and ' + Object.keys(peerDependencies).length +
    ' optional cross-built peers into ' + metaManifest.name +
    '; cross-built targets are direct dependencies of the consuming application'
  )

  return sliceDirs
}

// Development counterpart of slicePlatformPackages: turns a source build's
// prebuilds/<host>/ into <workdir>/node_modules/<platform package>/, the
// package the meta's "#host-addon" names, so a workspace-linked meta resolves,
// bundles and links exactly as an installed release does. Host dirs are linked
// rather than moved, so the meta keeps its prebuilds and a rebuild is picked up
// without re-running this. Only the hosts that were built are staged.
export function linkLocalPlatformPackages (options) {
  const { keepDirs = [], log = () => {} } = options
  const workdir = path.resolve(options.workdir)
  const metaManifest = readManifest(path.join(workdir, 'package.json'))
  const prebuildsDir = path.join(workdir, 'prebuilds')
  const hostDirs = listHostDirs(prebuildsDir, keepDirs)
  const known = new Set(collectKnownHosts())
  const unknown = hostDirs.filter((host) => !known.has(host))
  if (unknown.length > 0) {
    throw new Error('Unknown prebuild host dirs with no slice mapping: ' + unknown.join(', '))
  }
  if (hostDirs.length === 0) throw new Error('No host prebuilds under ' + prebuildsDir)

  const linked = []
  for (const definition of SLICE_DEFINITIONS) {
    const hosts = definition.hosts.filter((host) => hostDirs.includes(host))
    if (hosts.length === 0) continue
    for (const host of hosts) assertHostAddonPresent(prebuildsDir, metaManifest.name, host)

    const name = slicePackageName(metaManifest.name, definition)
    const packageDir = path.join(workdir, 'node_modules', ...name.split('/'))
    fs.rmSync(packageDir, { recursive: true, force: true })
    fs.mkdirSync(path.join(packageDir, 'prebuilds'), { recursive: true })
    writeManifest(path.join(packageDir, 'package.json'), buildSliceManifest(metaManifest, definition))
    fs.writeFileSync(path.join(packageDir, 'index.js'), PLATFORM_INDEX_SOURCE)
    for (const host of hosts) {
      // 'junction' is ignored off Windows, where it avoids needing the symlink privilege.
      fs.symlinkSync(path.join(prebuildsDir, host), path.join(packageDir, 'prebuilds', host), 'junction')
    }
    log('Linked ' + name + ' (' + hosts.join(', ') + ') -> ' + path.relative(workdir, packageDir))
    linked.push(packageDir)
  }
  return linked
}

function stageAllSlices (context, maxSliceMb, log) {
  const sliceDirs = []
  for (const definition of SLICE_DEFINITIONS) {
    const sliceDir = stageSlice(definition, context)
    const sizeMb = assertSliceSize(sliceDir, maxSliceMb)
    log('Staged ' + path.basename(sliceDir) + ' (' + sizeMb.toFixed(1) + ' MB unpacked)')
    sliceDirs.push(sliceDir)
  }
  return sliceDirs
}

function parseArgs (argv) {
  const options = {}
  for (let i = 0; i < argv.length; i += 2) {
    const flag = argv[i]
    if (flag === '--link-local') {
      options.linkLocal = true
      i -= 1
      continue
    }
    const value = argv[i + 1]
    if (value === undefined) throw new Error('Missing value for ' + flag)
    if (flag === '--workdir') options.workdir = value
    else if (flag === '--out-dir') options.outDir = value
    else if (flag === '--max-slice-mb') options.maxSliceMb = Number(value)
    else if (flag === '--keep-dirs') options.keepDirs = value.split(/[\s,]+/).filter(Boolean)
    else throw new Error('Unknown option: ' + flag)
  }
  if (!options.workdir || (!options.outDir && !options.linkLocal)) {
    throw new Error(
      'Usage: slice-platform-packages.mjs --workdir <dir> --out-dir <dir> ' +
      '[--max-slice-mb <n>] [--keep-dirs "<dir> <dir>"]\n' +
      '       slice-platform-packages.mjs --link-local --workdir <dir> [--keep-dirs "<dir> <dir>"]'
    )
  }
  return options
}

function main () {
  const options = parseArgs(process.argv.slice(2))
  options.log = (line) => console.log(line)
  if (options.linkLocal) linkLocalPlatformPackages(options)
  else slicePlatformPackages(options)
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main()
}
