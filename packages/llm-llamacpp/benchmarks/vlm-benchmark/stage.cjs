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
const imgs = fs.readdirSync(IMAGES).filter(f => /\.(png|jpe?g|webp|gif)$/i.test(f))
for (const f of imgs) fs.copyFileSync(path.join(IMAGES, f), path.join(ASSETS, f))
console.log(`staged ${imgs.length} images -> test/mobile/testAssets`)
