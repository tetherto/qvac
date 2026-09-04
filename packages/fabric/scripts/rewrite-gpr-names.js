'use strict'

const fs = require('node:fs')
const path = require('node:path')
const { addBareAliases } = require('./prepare-platform-packages')
const { gprPackageName, npmPackageName, SLICES } = require('./platform-slices')

function platformReplacements () {
  const replacements = SLICES.map((slice) => [
    npmPackageName(slice.name),
    gprPackageName(slice.name)
  ])
  replacements.sort((left, right) => right[0].length - left[0].length)
  return replacements
}

function rewriteValue (value, replacements) {
  if (typeof value === 'string') {
    for (const [from, to] of replacements) {
      if (value === from) return to
      value = value.split(from).join(to)
    }
    return value
  }
  if (Array.isArray(value)) return value.map((entry) => rewriteValue(entry, replacements))
  if (value && typeof value === 'object') {
    const next = {}
    for (const key of Object.keys(value)) next[key] = rewriteValue(value[key], replacements)
    return next
  }
  return value
}

function rewriteFile (file, replacements) {
  fs.writeFileSync(file, rewriteValue(fs.readFileSync(file, 'utf8'), replacements))
}

function rewriteMetaGprNames (directory, version) {
  const replacements = platformReplacements()
  rewriteFile(path.join(directory, 'platform.js'), replacements)

  const manifestPath = path.join(directory, 'package.json')
  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'))
  const next = {}
  for (const slice of SLICES) next[gprPackageName(slice.name)] = version || manifest.version
  manifest.optionalDependencies = next
  if (manifest.imports) manifest.imports = rewriteValue(manifest.imports, replacements)
  fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + '\n')
}

function rewriteSliceGprName (directory, version) {
  const manifestPath = path.join(directory, 'package.json')
  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'))
  const match = /^@qvac\/fabric-(.+)$/.exec(manifest.name)
  if (!match) throw new Error(`Not an @qvac/fabric platform package: ${manifest.name}`)
  manifest.name = gprPackageName(match[1])
  if (version) manifest.version = version
  fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + '\n')
  const prebuilds = path.join(directory, 'prebuilds')
  if (!fs.existsSync(prebuilds)) return
  for (const entry of fs.readdirSync(prebuilds, { withFileTypes: true })) {
    if (entry.isDirectory()) addBareAliases(path.join(prebuilds, entry.name), manifest.name)
  }
}

if (require.main === module) {
  const mode = process.argv[2]
  const directory = path.resolve(process.argv[3] || '.')
  const version = process.argv[4]
  if (mode === '--meta') rewriteMetaGprNames(directory, version)
  else if (mode === '--slice') rewriteSliceGprName(directory, version)
  else throw new Error('usage: rewrite-gpr-names.js --meta|--slice <dir> [version]')
}

module.exports = { rewriteMetaGprNames, rewriteSliceGprName }
