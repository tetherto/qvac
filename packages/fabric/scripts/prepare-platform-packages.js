'use strict'

// Slice the merged Fabric artifact immediately before publishing. These are
// staging directories, not source packages: the monorepo continues to own one
// Fabric package and one version.
const fs = require('node:fs')
const path = require('node:path')
const {
  ANDROID_FLAVOURS,
  SLICES,
  bareAddonBasename,
  expectedImports,
  expectedOptionalDependencies,
  npmPackageName,
  unpackedBudgetBytes
} = require('./platform-slices')

const root = path.resolve(__dirname, '..')

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

function addBareAliases (prebuildDir, packageName) {
  const alias = `${bareAddonBasename(packageName)}.bare`
  const source = 'qvac__fabric.bare'
  if (alias === source) return
  const sourcePath = path.join(prebuildDir, source)
  if (!fs.existsSync(sourcePath)) return
  linkOrCopy(sourcePath, path.join(prebuildDir, alias), source)
  const exportsSource = `${source}.exports`
  const exportsSourcePath = path.join(prebuildDir, exportsSource)
  if (fs.existsSync(exportsSourcePath)) {
    linkOrCopy(exportsSourcePath, path.join(prebuildDir, `${alias}.exports`), exportsSource)
  }
}

function linkOrCopy (from, to, relative) {
  fs.rmSync(to, { force: true })
  try {
    fs.symlinkSync(relative, to)
  } catch {
    fs.copyFileSync(from, to)
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
    addon: true,
    os: [slice.os],
    engines: meta.engines,
    files: ['binding.js', 'prebuilds', 'LICENSE', 'NOTICE'],
    exports: { '.': './binding.js', './package': './package.json' },
    license: meta.license,
    repository: meta.repository
  }
  if (slice.cpu) manifest.cpu = [slice.cpu]
  if (slice.libc) manifest.libc = [slice.libc]
  fs.writeFileSync(path.join(destination, 'package.json'), JSON.stringify(manifest, null, 2) + '\n')
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
    const prebuilds = path.join(destination, 'prebuilds')
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
    fs.writeFileSync(path.join(destination, 'binding.js'), 'module.exports = require.addon()\n')
    fs.copyFileSync(path.join(root, 'LICENSE'), path.join(destination, 'LICENSE'))
    fs.copyFileSync(path.join(root, 'NOTICE'), path.join(destination, 'NOTICE'))
    writeSliceManifest(destination, slice, meta)
    const packageName = npmPackageName(slice.name)
    for (const directory of fs.readdirSync(prebuilds)) {
      addBareAliases(path.join(prebuilds, directory), packageName)
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

module.exports = { addBareAliases, prepare }
