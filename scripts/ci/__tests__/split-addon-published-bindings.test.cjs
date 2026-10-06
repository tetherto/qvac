'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { spawnSync } = require('node:child_process')

const repoRoot = path.resolve(__dirname, '../../..')
const slicerPromise = import('../slice-platform-packages.mjs')

function makeFixture(t, manifest, sourceDir, hosts) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'split-addon-slice-'))
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  const workdir = path.join(root, 'meta')
  const prebuilds = path.join(workdir, 'prebuilds')
  fs.mkdirSync(prebuilds, { recursive: true })
  fs.writeFileSync(path.join(workdir, 'package.json'), JSON.stringify(manifest, null, 2) + '\n')

  for (const name of ['binding.js', 'binding-published.js']) {
    fs.copyFileSync(path.join(sourceDir, name), path.join(workdir, name))
  }
  for (const host of hosts) {
    const dir = path.join(prebuilds, host)
    fs.mkdirSync(dir, { recursive: true })
    fs.writeFileSync(path.join(dir, 'test.bare'), 'native addon')
  }

  return { workdir, outDir: path.join(root, 'slices') }
}

function packedFiles(workdir) {
  const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm'
  const result = spawnSync(npm, ['pack', '--dry-run', '--json', '--ignore-scripts'], {
    cwd: workdir,
    encoding: 'utf8'
  })
  assert.equal(result.status, 0, `${result.stdout}${result.stderr}`)
  return JSON.parse(result.stdout)[0].files.map((file) => file.path)
}

test('release slicing selects the audiogen published loader', async (t) => {
  const { slicePlatformPackages, SLICE_DEFINITIONS } = await slicerPromise
  const hosts = SLICE_DEFINITIONS.flatMap((definition) => definition.hosts)

  for (const name of ['audiogen-ggml']) {
    const sourceDir = path.join(repoRoot, 'packages', name)
    const manifest = require(path.join(sourceDir, 'package.json'))
    const { workdir, outDir } = makeFixture(t, manifest, sourceDir, hosts)
    const publishedBinding = fs.readFileSync(path.join(sourceDir, 'binding-published.js'), 'utf8')

    slicePlatformPackages({ workdir, outDir })

    assert.equal(fs.existsSync(path.join(workdir, 'prebuilds')), false)
    assert.equal(fs.readFileSync(path.join(workdir, 'binding.js'), 'utf8'), publishedBinding)
    assert.deepEqual(
      packedFiles(workdir).filter((file) => file.includes('binding')),
      ['binding.js']
    )
  }
})
