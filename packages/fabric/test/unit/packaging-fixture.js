const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')

async function fixture(t) {
  const slicer = await import('../../../../scripts/ci/slice-platform-packages.mjs')
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'fabric-packages-'))
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  const workdir = path.join(root, 'fabric')
  const outDir = path.join(root, 'out')
  fs.mkdirSync(workdir)
  const manifest = { ...require('../../package.json') }
  fs.writeFileSync(path.join(workdir, 'package.json'), JSON.stringify(manifest))
  for (const file of ['LICENSE', 'NOTICE']) {
    fs.copyFileSync(path.join(__dirname, '../..', file), path.join(workdir, file))
  }
  const definitions = [...slicer.SLICE_DEFINITIONS, ...slicer.FABRIC_BACKEND_DEFINITIONS]
  for (const definition of definitions) {
    const moduleName = slicer.mangledAddonName(slicer.slicePackageName(manifest.name, definition))
    for (const host of definition.hosts) {
      const dir = path.join(workdir, 'prebuilds', host)
      fs.mkdirSync(path.join(dir, moduleName), { recursive: true })
      fs.writeFileSync(path.join(dir, moduleName + '.bare'), 'runtime')
      fs.writeFileSync(path.join(dir, moduleName + '.bare.exports'), 'exports')
      fs.writeFileSync(
        path.join(dir, moduleName, 'libqvac-ggml-' + (definition.backend || 'cpu-x64') + '.so'),
        'backend'
      )
    }
  }
  const base = path.join(workdir, 'prebuilds/linux-x64/qvac__fabric-linux-x64')
  fs.writeFileSync(path.join(base, 'fused_layer.xclbin'), 'kernel')
  fs.writeFileSync(path.join(base, 'fused_layer.insts.bin'), 'instructions')
  return { ...slicer, root, workdir, outDir, manifest }
}

module.exports = { fixture }
