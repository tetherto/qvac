'use strict'

const fs = require('node:fs')
const path = require('node:path')

function platformPackageDirName (platKey) {
  if (platKey.startsWith('ios-')) return 'fabric-ios'
  if (platKey.startsWith('android-')) return 'fabric-android-arm64'
  return `fabric-${platKey}`
}

function bareAddonBasename (packageName) {
  return packageName.replace(/^@/, '').replace('/', '__')
}

function validate (directory, relative) {
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    const child = relative ? `${relative}/${entry.name}` : entry.name
    if (entry.isSymbolicLink()) {
      throw new Error(`symlink in fabric prebuilds: ${child}`)
    }
    if (entry.isDirectory()) {
      validate(path.join(directory, entry.name), child)
      continue
    }
    if (!entry.isFile()) {
      throw new Error(`non-regular file in fabric prebuilds: ${child}`)
    }
    if (child.startsWith('share/') && !entry.name.endsWith('.cmake')) {
      throw new Error(`non-cmake file under share/: ${child}`)
    }
  }
}

function renameArtifacts (root) {
  for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
    const source = path.join(root, entry.name)
    if (entry.isDirectory()) renameArtifacts(source)
    if (!entry.name.startsWith('tetherto_')) continue
    const target = path.join(root, `qvac_${entry.name.slice(9)}`)
    fs.renameSync(source, target)
  }
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

function writePlatformStub (packageDir, packageName) {
  fs.mkdirSync(packageDir, { recursive: true })
  fs.writeFileSync(path.join(packageDir, 'binding.js'), 'module.exports = require.addon()\n')
  fs.writeFileSync(path.join(packageDir, 'package.json'), JSON.stringify({
    name: packageName,
    version: '0.0.0-overlay',
    addon: true,
    files: ['binding.js', 'prebuilds'],
    exports: { '.': './binding.js', './package': './package.json' }
  }, null, 2) + '\n')
}

function copyTree (from, to) {
  fs.rmSync(to, { recursive: true, force: true })
  fs.cpSync(from, to, { recursive: true })
}

function overlayHost (src, metaPrebuilds, scopeDir, platKey) {
  const platDir = path.join(src, platKey)
  if (!fs.existsSync(platDir) || !fs.statSync(platDir).isDirectory()) {
    throw new Error(`No '${platKey}/' in fabric prebuilds at ${src}`)
  }
  const leftover = path.join(metaPrebuilds, platKey)
  fs.rmSync(leftover, { recursive: true, force: true })
  const dirName = platformPackageDirName(platKey)
  const packageName = `@qvac/${dirName}`
  const packageDir = path.join(scopeDir, dirName)
  writePlatformStub(packageDir, packageName)
  const destPlat = path.join(packageDir, 'prebuilds', platKey)
  copyTree(platDir, destPlat)
  renameArtifacts(destPlat)
  addBareAliases(destPlat, packageName)
  return packageDir
}

function overlayMetaJs (metaPkg, workspace) {
  const source = path.join(workspace, 'packages', 'fabric')
  for (const file of ['binding.js', 'platform.js']) {
    const from = path.join(source, file)
    if (fs.existsSync(from)) fs.copyFileSync(from, path.join(metaPkg, file))
  }
}

function overlayTree (src, metaPkg, platform, arch, tags) {
  const metaPrebuilds = path.join(metaPkg, 'prebuilds')
  const scopeDir = path.dirname(metaPkg)
  fs.mkdirSync(metaPrebuilds, { recursive: true })
  copyTree(path.join(src, 'include'), path.join(metaPrebuilds, 'include'))
  copyTree(path.join(src, 'share'), path.join(metaPrebuilds, 'share'))
  renameArtifacts(metaPrebuilds)

  if (platform && arch) {
    return [overlayHost(src, metaPrebuilds, scopeDir, `${platform}-${arch}${tags || ''}`)]
  }

  const planted = []
  for (const entry of fs.readdirSync(src, { withFileTypes: true })) {
    if (!entry.isDirectory() || !entry.name.includes('-')) continue
    if (entry.name === 'include' || entry.name === 'share') continue
    planted.push(overlayHost(src, metaPrebuilds, scopeDir, entry.name))
  }
  return planted
}

function discoverFabricPackages (searchRoot) {
  const direct = path.join(searchRoot, 'node_modules', '@qvac', 'fabric')
  return fs.existsSync(direct) && fs.statSync(direct).isDirectory() ? [direct] : []
}

function fail (message) {
  console.error(`::error::${message}`)
  throw new Error(message)
}

function main () {
  const src = process.env.SRC
  const workdir = process.env.WORKDIR
  const workspace = process.env.GITHUB_WORKSPACE || process.cwd()
  const extra = (process.env.SEARCH_DIRS || '').trim()
  if (!src || !fs.existsSync(src) || !fs.statSync(src).isDirectory()) {
    fail(`Fabric prebuilds root does not exist: ${src}`)
  }
  if (!fs.existsSync(path.join(src, 'include')) || !fs.existsSync(path.join(src, 'share'))) {
    fail(`Fabric prebuilds must contain both include/ and share/: ${src}`)
  }
  try {
    validate(src, '')
  } catch (error) {
    fail(`Fabric prebuilds failed content validation: ${src} (${error.message})`)
  }

  const search = [
    path.resolve(workdir),
    path.resolve(workspace),
    ...extra.split(/\s+/).filter(Boolean).map((dir) => path.resolve(dir))
  ]
  const seen = new Set()
  const packages = []
  for (const root of search) {
    for (const pkg of discoverFabricPackages(root)) {
      if (seen.has(pkg)) continue
      seen.add(pkg)
      packages.push(pkg)
    }
  }
  if (packages.length === 0) {
    const details = search.map((root) => {
      const scope = path.join(root, 'node_modules', '@qvac')
      if (!fs.existsSync(scope)) return ''
      return `Contents of ${scope}: ${fs.readdirSync(scope).join(', ')}`
    }).filter(Boolean)
    fail(`No installed @qvac/fabric found under ${search.join(' ')}\n${details.join('\n')}`)
  }

  for (const pkg of packages) {
    let planted
    try {
      planted = overlayTree(
        src,
        pkg,
        process.env.PLATFORM,
        process.env.ARCH,
        process.env.TAGS
      )
    } catch (error) {
      fail(error.message)
    }
    console.log(`Overlaid PR fabric headers into ${path.join(pkg, 'prebuilds')}`)
    overlayMetaJs(pkg, workspace)
    for (const dest of planted) console.log(`Overlaid PR fabric runtime into ${dest}`)
  }
}

module.exports = {
  addBareAliases,
  overlayTree,
  platformPackageDirName,
  validate
}

if (require.main === module) main()
