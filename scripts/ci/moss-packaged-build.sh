#!/usr/bin/env bash
set -euo pipefail
root="$PWD"
for package in tts-ggml asr-ggml; do
  cd "$root/packages/$package"
  # Fail before compiling if the intended registry/native pins have drifted.
  node <<'JS'
const assert = require('node:assert/strict')
const manifest = require('./vcpkg.json')
for (const [name, version] of [['speech-cpp', '2026-10-12'], ['ggml-speech', '2026-10-07']]) {
  const pin = manifest.overrides.find(p => p.name === name)
  assert.equal(pin.version, version)
  assert.equal(pin['port-version'], 1)
}
assert.equal(require('./vcpkg-configuration.json')['default-registry'].baseline,
  'e31be272ecdf9f20970302ebf8a2943d47803001')
JS
  cp vcpkg.json "$root/moss-packaged-results/$package-vcpkg.json"
  cp vcpkg-configuration.json "$root/moss-packaged-results/$package-registry.json"
  npm install --ignore-scripts
  npm install --no-save --ignore-scripts bare-make
  export PATH="$PWD/node_modules/.bin:$PATH"
  npm run build:ts
  rm -rf build prebuilds
  if [ "$package" = tts-ggml ]; then
    bare-make generate --platform linux --arch x64 -D ENABLE_CUDA=ON -D BUILD_TESTING=OFF -D BUILD_FUZZING=OFF
  else
    bare-make generate --platform linux --arch x64 -D ASR_CUDA=ON -D BUILD_TESTING=OFF
  fi
  bare-make build
  bare-make install
  npm run link:platform
  # Prove #host-addon resolves to this build, including BOTH dynamic plugins.
  node <<'JS'
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const local = path.resolve('prebuilds/linux-x64')
const staged = path.resolve('node_modules/@qvac/' + path.basename(process.cwd()) + '-linux-x64/prebuilds/linux-x64')
assert.equal(fs.realpathSync(staged), local)
const files = fs.readdirSync(local, { recursive: true })
assert(files.some(f => f.endsWith('.bare')), 'fresh addon missing')
for (const backend of ['cuda', 'vulkan']) {
  assert(files.some(f => f.includes('ggml-' + backend) && f.includes('.so')), backend + ' plugin missing')
}
console.log(JSON.stringify({ package: path.basename(process.cwd()), hostAddon: staged, files }, null, 2))
JS
  find prebuilds/linux-x64 -type f -exec sha256sum {} + > "$root/moss-packaged-results/$package-prebuilds.sha256"
done
