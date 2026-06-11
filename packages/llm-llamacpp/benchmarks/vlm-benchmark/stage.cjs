'use strict'
// QVAC-19178: stage the VLM benchmark into the locations the mobile test framework
// scans and bundles. The source of truth is THIS directory; the copies written here
// are git-ignored. Run before the mobile build (the reusable mobile workflow's
// `pre_build_script` input points at this file). Desktop needs NO staging — its CI
// leg points brittle straight at benchmarks/vlm-benchmark/vlm-matrix.test.js.
//
// The mobile generator scans test/integration/*.test.js (→ runVlmMatrixTest) and the
// app bundles test/mobile/testAssets/. Because both test/integration and this dir are
// 2 levels under packages/llm-llamacpp, the staged harness's ../../-relative requires
// resolve to the same files; ./ requires resolve against the staged siblings.
const fs = require('fs')
const path = require('path')

const HERE = __dirname
const INTEG = path.resolve(HERE, '..', '..', 'test', 'integration')
const ASSETS = path.resolve(HERE, '..', '..', 'test', 'mobile', 'testAssets')
const IMAGES = path.join(HERE, 'images')

// The entry + the modules it requires must sit together in test/integration so the
// entry's `./harness.cjs` / harness's `./config.cjs` `./fixture.data.cjs` resolve.
const CODE = ['vlm-matrix.test.js', 'harness.cjs', 'config.cjs', 'fixture.data.cjs']

fs.mkdirSync(INTEG, { recursive: true })
fs.mkdirSync(ASSETS, { recursive: true })

for (const f of CODE) {
  fs.copyFileSync(path.join(HERE, f), path.join(INTEG, f))
  console.log(`staged -> test/integration/${f}`)
}
// Images aren't in git — CI syncs them from the fixture object store (URI configured
// in the benchmark workflow) into images/ before this runs. Fail loudly if skipped.
const imgs = fs.existsSync(IMAGES) ? fs.readdirSync(IMAGES).filter(f => /\.(png|jpe?g|webp|gif)$/i.test(f)) : []
if (!imgs.length) throw new Error(`No images in ${IMAGES} — sync the fixture image store into it first`)
for (const f of imgs) fs.copyFileSync(path.join(IMAGES, f), path.join(ASSETS, f))
console.log(`staged ${imgs.length} images -> test/mobile/testAssets`)

// Register the test in test-groups.json so the mobile generator's per-platform grouping
// validation passes (it requires EVERY test to be in a group, on every platform). This
// edit is ephemeral (the file is pristine on a fresh checkout); the workflow's
// `test_groups` override still narrows the actual Device Farm run to just this group.
const GROUPS = path.resolve(HERE, '..', '..', 'test', 'mobile', 'test-groups.json')
if (fs.existsSync(GROUPS)) {
  const groups = JSON.parse(fs.readFileSync(GROUPS, 'utf8'))
  for (const platform of Object.keys(groups)) groups[platform].vlmMatrix = ['runVlmMatrixTest']
  fs.writeFileSync(GROUPS, JSON.stringify(groups, null, 2) + '\n')
  console.log(`registered runVlmMatrixTest in test-groups.json (${Object.keys(groups).join(', ')})`)
}
