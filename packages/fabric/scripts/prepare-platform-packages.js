'use strict'

// Slice the merged Fabric artifact immediately before publishing. These are
// staging directories, not source packages: the monorepo continues to own one
// Fabric package and one version.
const fs = require('node:fs')
const path = require('node:path')
const {
  ANDROID_FLAVOURS,
  SLICES,
  expectedImports,
  expectedOptionalDependencies,
  npmPackageName,
  unpackedBudgetBytes
} = require('./platform-slices')

const root = path.resolve(__dirname, '..')

// The runtime lives under `addon/`, whose package.json is named @qvac/fabric.
// require.addon('./addon') and cmake-bare's include_bare_module both derive the
// artifact basename from the nearest manifest, so the .bare keeps the name every
// consumer already links against (qvac__fabric) without a renamed second copy.
const ADDON_DIR = 'addon'
const ADDON_FILE = 'qvac__fabric.bare'
const ADDON_INDEX = `module.exports = require.addon('./${ADDON_DIR}')\n`

function copy (from, to) {
  fs.mkdirSync(path.dirname(to), { recursive: true })
  fs.cpSync(from, to, { recursive: true })
}

function directorySize (directory) {
  let total = 0
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    const full = path.join(directory, entry.name)
    if (entry.isDirectory()) total += directorySize(full)
    else total += fs.statSync(full).size
  }
  return total
}

function assertEqualJson (actual, expected, label) {
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new Error(`@qvac/fabric ${label} does not match the platform slice table`)
  }
}

function assertOptionalDependencies (meta) {
  assertEqualJson(
    meta.optionalDependencies || {},
    expectedOptionalDependencies(meta.version),
    'optionalDependencies'
  )
}

function assertImports (meta) {
  assertEqualJson(meta.imports || {}, expectedImports(), 'imports')
}

function assertHostAddonPresent (prebuildDir, host, packageName) {
  if (!fs.existsSync(path.join(prebuildDir, ADDON_FILE))) {
    throw new Error(
      `No ${ADDON_FILE} under prebuilds/${host} of ${packageName}. ` +
      'Refusing to publish a binary-less platform package.'
    )
  }
}

function groupedDirectories (source, slice) {
  const existing = fs.readdirSync(source).filter((entry) => {
    return entry.startsWith(slice.groupPrefix) && fs.statSync(path.join(source, entry)).isDirectory()
  })
  if (slice.name === 'android-arm64') {
    if (!existing.includes('android-arm64')) {
      throw new Error(`Missing Fabric prebuild slice android-arm64 in ${source}`)
    }
    const aliases = ANDROID_FLAVOURS.filter((flavour) => !existing.includes(flavour))
    return { directories: existing, aliases }
  }
  if (existing.length === 0) {
    throw new Error(`Missing Fabric prebuild slice ${slice.name} in ${source}`)
  }
  return { directories: existing, aliases: [] }
}

function writeSliceManifest (destination, slice, meta) {
  const manifest = {
    name: npmPackageName(slice.name),
    version: meta.version,
    description: `Platform runtime for @qvac/fabric (${slice.name})`,
    os: [slice.os],
    engines: meta.engines,
    files: ['index.js', ADDON_DIR, 'LICENSE', 'NOTICE'],
    exports: { '.': './index.js', './package': './package.json' },
    license: meta.license,
    repository: meta.repository
  }
  if (slice.cpu) manifest.cpu = [slice.cpu]
  if (slice.libc) manifest.libc = [slice.libc]
  fs.writeFileSync(path.join(destination, 'package.json'), JSON.stringify(manifest, null, 2) + '\n')
}

// Named @qvac/fabric, not @qvac/fabric-<slice>: this is what pins the .bare
// basename and keeps the GPR rename from touching the artifact.
function writeInnerAddonManifest (addonDir, meta) {
  const manifest = { name: meta.name, version: meta.version, addon: true }
  fs.writeFileSync(path.join(addonDir, 'package.json'), JSON.stringify(manifest, null, 2) + '\n')
}

function prepare (source, output, metaPath) {
  const meta = JSON.parse(fs.readFileSync(metaPath || path.join(root, 'package.json')))
  assertOptionalDependencies(meta)
  assertImports(meta)
  if (!fs.existsSync(source)) throw new Error(`Fabric prebuilds not found: ${source}`)
  fs.rmSync(output, { recursive: true, force: true })
  fs.mkdirSync(output, { recursive: true })

  for (const slice of SLICES) {
    const destination = path.join(output, slice.name)
    const addonDir = path.join(destination, ADDON_DIR)
    const prebuilds = path.join(addonDir, 'prebuilds')
    const grouped = slice.groupPrefix
      ? groupedDirectories(source, slice)
      : { directories: [slice.name], aliases: [] }
    const missing = grouped.directories.filter((entry) => !fs.existsSync(path.join(source, entry)))
    if (!slice.groupPrefix && (grouped.directories.length === 0 || missing.length > 0)) {
      throw new Error(`Missing Fabric prebuild slice ${slice.name} in ${source}`)
    }
    fs.mkdirSync(prebuilds, { recursive: true })
    for (const directory of grouped.directories) {
      copy(path.join(source, directory), path.join(prebuilds, directory))
    }
    if (slice.name === 'android-arm64') {
      const arm64 = path.join(prebuilds, 'android-arm64')
      for (const flavour of grouped.aliases) copy(arm64, path.join(prebuilds, flavour))
    }
    fs.writeFileSync(path.join(destination, 'index.js'), ADDON_INDEX)
    fs.copyFileSync(path.join(root, 'LICENSE'), path.join(destination, 'LICENSE'))
    fs.copyFileSync(path.join(root, 'NOTICE'), path.join(destination, 'NOTICE'))
    writeSliceManifest(destination, slice, meta)
    writeInnerAddonManifest(addonDir, meta)
    const packageName = npmPackageName(slice.name)
    for (const directory of fs.readdirSync(prebuilds)) {
      assertHostAddonPresent(path.join(prebuilds, directory), directory, packageName)
    }
    const size = directorySize(destination)
    const budget = unpackedBudgetBytes(slice.name)
    if (size > budget) {
      throw new Error(
        `${packageName} unpacked size ${size} exceeds budget ${budget}`
      )
    }
  }
}

if (require.main === module) {
  prepare(
    path.resolve(process.argv[2] || path.join(root, 'prebuilds')),
    path.resolve(process.argv[3] || path.join(root, 'dist', 'platforms'))
  )
}

module.exports = { ADDON_DIR, prepare }
