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
  { suffix: 'android-arm64', hosts: ['android-arm64'], os: ['android'], cpu: ['arm64'] },
  { suffix: 'ios', hosts: ['ios-arm64', 'ios-arm64-simulator', 'ios-x64-simulator'], os: ['ios'] }
]

export const PLATFORM_INDEX_SOURCE = "module.exports = require.addon('./addon')\n"

const DEFAULT_MAX_SLICE_MB = 450
const BYTES_PER_MB = 1024 * 1024
const MANIFEST_INDENT = 2
const META_FILES_TO_COPY = ['LICENSE', 'NOTICE']
const BARE_ADDON_EXTENSION = '.bare'

export function hostToSliceSuffix (host) {
  const definition = SLICE_DEFINITIONS.find((slice) => slice.hosts.includes(host))
  return definition ? definition.suffix : null
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

function assertHostAddonPresent (prebuildsDir, host) {
  const entries = fs.readdirSync(path.join(prebuildsDir, host))
  if (!entries.some((entry) => entry.endsWith(BARE_ADDON_EXTENSION))) {
    throw new Error(
      'No ' + BARE_ADDON_EXTENSION + ' addon under prebuilds/' + host +
      '. Refusing to publish a binary-less platform package.'
    )
  }
}

function assertAllHostAddonsPresent (prebuildsDir) {
  for (const host of collectKnownHosts()) {
    assertHostAddonPresent(prebuildsDir, host)
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
    name: metaManifest.name + '-' + definition.suffix,
    version: metaManifest.version,
    description: 'Prebuilt ' + definition.suffix + ' binaries for ' + metaManifest.name,
    main: 'index.js',
    exports: {
      '.': './index.js',
      './package': './package.json'
    },
    files: ['index.js', 'addon', 'NOTICE'],
    os: definition.os,
    repository: metaManifest.repository,
    author: metaManifest.author,
    license: metaManifest.license,
    bugs: metaManifest.bugs,
    homepage: metaManifest.homepage,
    engines: metaManifest.engines
  }
  if (definition.cpu) manifest.cpu = definition.cpu
  if (definition.libc) manifest.libc = definition.libc
  return manifest
}

export function buildInnerAddonManifest (metaManifest) {
  return {
    name: metaManifest.name,
    version: metaManifest.version,
    addon: true
  }
}

export function buildSliceReadme (metaManifest, definition) {
  return '# ' + metaManifest.name + '-' + definition.suffix + '\n\n' +
    'Prebuilt ' + definition.suffix + ' binaries for [' + metaManifest.name +
    '](https://www.npmjs.com/package/' + metaManifest.name + ').\n\n' +
    'Do not depend on this package directly. Install ' + metaManifest.name +
    ' instead; package managers that support `os`/`cpu` filtered optional\n' +
    'dependencies (npm 7+, pnpm, bun, Yarn Berry) select the right platform\n' +
    'package automatically.\n'
}

export function buildOptionalDependencies (metaManifest, definitions) {
  const optionalDependencies = {}
  for (const definition of definitions) {
    optionalDependencies[metaManifest.name + '-' + definition.suffix] = metaManifest.version
  }
  return optionalDependencies
}

function readManifest (manifestPath) {
  return JSON.parse(fs.readFileSync(manifestPath, 'utf8'))
}

function writeManifest (manifestPath, manifest) {
  fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, MANIFEST_INDENT) + '\n')
}

function listHostDirs (prebuildsDir) {
  if (!fs.existsSync(prebuildsDir)) {
    throw new Error('No prebuilds directory at ' + prebuildsDir)
  }
  return fs
    .readdirSync(prebuildsDir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort()
}

function sliceDirName (metaManifest, definition) {
  return metaManifest.name.replace('@', '').replace('/', '-') + '-' + definition.suffix
}

function stageSlice (definition, context) {
  const { metaManifest, workdir, outDir, prebuildsDir } = context
  const sliceDir = path.join(outDir, sliceDirName(metaManifest, definition))
  const addonDir = path.join(sliceDir, 'addon')
  const addonPrebuildsDir = path.join(addonDir, 'prebuilds')
  fs.mkdirSync(addonPrebuildsDir, { recursive: true })

  writeManifest(path.join(sliceDir, 'package.json'), buildSliceManifest(metaManifest, definition))
  writeManifest(path.join(addonDir, 'package.json'), buildInnerAddonManifest(metaManifest))
  fs.writeFileSync(path.join(sliceDir, 'index.js'), PLATFORM_INDEX_SOURCE)
  fs.writeFileSync(path.join(sliceDir, 'README.md'), buildSliceReadme(metaManifest, definition))
  copyMetaFiles(workdir, sliceDir)
  moveHostDirs(definition.hosts, prebuildsDir, addonPrebuildsDir)

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

function moveHostDirs (hosts, prebuildsDir, addonPrebuildsDir) {
  for (const host of hosts) {
    fs.renameSync(path.join(prebuildsDir, host), path.join(addonPrebuildsDir, host))
  }
}

function removeEmptiedPrebuildsDir (prebuildsDir) {
  const leftovers = fs.readdirSync(prebuildsDir)
  if (leftovers.length > 0) {
    throw new Error('Unexpected leftover entries under ' + prebuildsDir + ': ' + leftovers.join(', '))
  }
  fs.rmdirSync(prebuildsDir)
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
  const { workdir, outDir, maxSliceMb = DEFAULT_MAX_SLICE_MB, log = () => {} } = options
  const metaManifestPath = path.join(workdir, 'package.json')
  const metaManifest = readManifest(metaManifestPath)
  const prebuildsDir = path.join(workdir, 'prebuilds')

  validateHostDirs(listHostDirs(prebuildsDir))
  assertAllHostAddonsPresent(prebuildsDir)
  fs.mkdirSync(outDir, { recursive: true })

  const context = { metaManifest, workdir, outDir, prebuildsDir }
  const sliceDirs = stageAllSlices(context, maxSliceMb, log)

  removeEmptiedPrebuildsDir(prebuildsDir)
  metaManifest.optionalDependencies = buildOptionalDependencies(metaManifest, SLICE_DEFINITIONS)
  writeManifest(metaManifestPath, metaManifest)
  log('Injected ' + SLICE_DEFINITIONS.length + ' optionalDependencies into ' + metaManifest.name)

  return sliceDirs
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
    const value = argv[i + 1]
    if (value === undefined) throw new Error('Missing value for ' + flag)
    if (flag === '--workdir') options.workdir = value
    else if (flag === '--out-dir') options.outDir = value
    else if (flag === '--max-slice-mb') options.maxSliceMb = Number(value)
    else throw new Error('Unknown option: ' + flag)
  }
  if (!options.workdir || !options.outDir) {
    throw new Error('Usage: slice-platform-packages.mjs --workdir <dir> --out-dir <dir> [--max-slice-mb <n>]')
  }
  return options
}

function main () {
  const options = parseArgs(process.argv.slice(2))
  options.log = (line) => console.log(line)
  slicePlatformPackages(options)
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main()
}
