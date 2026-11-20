const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const { fixture } = require('./packaging-fixture')

async function setup(t) {
  const f = await fixture(t)
  for (const file of ['binding.js', 'addon-unavailable.js', 'README.md']) {
    fs.writeFileSync(path.join(f.workdir, file), 'fixture')
  }
  for (const dir of ['include', 'share']) fs.mkdirSync(path.join(f.workdir, 'prebuilds', dir))
  const consumerDir = path.join(f.root, 'consumer')
  fs.mkdirSync(path.join(consumerDir, 'prebuilds/linux-x64'), { recursive: true })
  fs.writeFileSync(path.join(consumerDir, 'prebuilds/linux-x64/qvac__llm-llamacpp.bare'), 'addon')
  fs.writeFileSync(path.join(consumerDir, 'README.md'), 'fixture')
  fs.writeFileSync(path.join(consumerDir, 'index.js'), 'fixture')
  fs.writeFileSync(
    path.join(consumerDir, 'package.json'),
    JSON.stringify({
      name: '@qvac/llm-llamacpp',
      version: '1.0.0',
      files: ['index.js', 'prebuilds'],
      dependencies: { '@qvac/fabric': '^0.1.0' }
    })
  )
  const { stagePackages } = await import('../../../llm-llamacpp/ci/fabric-package-smoke.mjs')
  const root = path.join(f.root, 'registry')
  return {
    ...f,
    consumerDir,
    stage: () => stagePackages({ fabricDir: f.workdir, consumerDir, root })
  }
}

test('registry staging uses real host payloads, pins Fabric, and preserves source artifacts', async (t) => {
  const f = await setup(t)
  const { dirs } = f.stage()
  assert.equal(dirs.length, 4)
  const read = (dir) => JSON.parse(fs.readFileSync(path.join(dir, 'package.json')))
  const base = dirs.find((dir) => read(dir).name === '@qvac/fabric-linux-x64')
  assert.ok(
    fs.existsSync(path.join(base, 'prebuilds/linux-x64/qvac__fabric-linux-x64/libqvac-ggml-hip.so'))
  )
  assert.ok(!fs.existsSync(path.join(base, 'prebuilds/linux-x64/qvac__fabric-linux-x64-cuda.bare')))
  assert.ok(
    fs.existsSync(path.join(f.workdir, 'prebuilds/linux-x64/qvac__fabric-linux-x64-cuda.bare'))
  )
  assert.deepEqual(read(dirs[0]).optionalDependencies, {
    '@qvac/fabric-linux-x64': f.manifest.version
  })
  assert.equal(read(dirs[3]).dependencies['@qvac/fabric'], f.manifest.version)
  assert.deepEqual(fs.readdirSync(path.join(base, 'prebuilds')), ['linux-x64'])
})

test('registry smoke refuses missing CUDA, HIP, and consumer build artifacts', async (t) => {
  for (const file of [
    'prebuilds/linux-x64/qvac__fabric-linux-x64-cuda/libqvac-ggml-cuda.so',
    'prebuilds/linux-x64/qvac__fabric-linux-x64/libqvac-ggml-hip.so',
    'consumer'
  ]) {
    const f = await setup(t)
    fs.unlinkSync(
      file === 'consumer'
        ? path.join(f.consumerDir, 'prebuilds/linux-x64/qvac__llm-llamacpp.bare')
        : path.join(f.workdir, file)
    )
    assert.throws(f.stage, /Missing Fabric backend package|missing HIP|missing PR consumer/)
  }
})

// Nx exports color variables that can make Node warn before npm writes JSON.
// stderr must never corrupt the npm pack metadata consumed by the size gate.
test('registry runner keeps npm JSON separate from process warnings', async (t) => {
  const f = await fixture(t)
  const { run } = await import('../../../llm-llamacpp/ci/fabric-package-smoke.mjs')
  const log = path.join(f.root, 'pack.log')
  await run(
    process.execPath,
    [
      '-e',
      'process.stderr.write("warning\\n"); process.stdout.write(JSON.stringify([{size: 123}]))'
    ],
    {
      cwd: f.root,
      env: process.env,
      log
    }
  )
  assert.deepEqual(JSON.parse(fs.readFileSync(log)), [{ size: 123 }])
  assert.match(fs.readFileSync(log + '.stderr', 'utf8'), /warning/)
})
