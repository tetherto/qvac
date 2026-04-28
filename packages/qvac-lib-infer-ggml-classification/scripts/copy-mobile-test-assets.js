#!/usr/bin/env node
'use strict'

// Prepare prebuilds and test assets for the on-device mobile test framework.
//
// Two responsibilities:
//
//   1. Replicate the single arm64 native prebuild we ship across the
//      additional `<platform>-<arch>` directory names that the mobile
//      test framework expects to find under `prebuilds/`. Without these
//      copies the framework cannot match a native binary for the device
//      arch flavour it is targeting (e.g. android-x64, ios-arm64-simulator).
//
//   2. Copy the FP16 GGUF weights bundle from `weights/` into
//      `test/mobile/testAssets/`. On mobile, the bare runtime cannot
//      access files in the npm package's `weights/` directory at runtime
//      because the worklet is loaded from a packed `.bundle`; the test
//      framework instead pushes everything under `test/mobile/testAssets/`
//      to the device and exposes their on-device paths via
//      `global.assetPaths`. Without this copy `ImageClassifier.load()`
//      fails with `MobileNet GGUF weights not found at /app.bundle/...`.
//
// Idempotent: every action is a copy that overwrites silently if the
// destination already exists.

const fs = require('fs')
const path = require('path')

const ADDON_DIR = path.resolve(__dirname, '..')
const PREBUILDS_DIR = path.join(ADDON_DIR, 'prebuilds')
const WEIGHTS_DIR = path.join(ADDON_DIR, 'weights')
const TEST_ASSETS_DIR = path.join(ADDON_DIR, 'test', 'mobile', 'testAssets')

// The qvac-test-addon-mobile framework's metro.config.js registers
// `assetExts: ['so', 'bin', 'model', 'bundle', 'raw', 'onnx']`. It does
// NOT include `.gguf`, so a file with that extension placed under
// `testAssets/` is treated by the React Native bundler as a JS-source
// request and the on-device build aborts with
//   `Unable to resolve module ../assets/testAssets/<file>.gguf`
// at the `:app:createBundleReleaseJsAndAssets` step (see CI run
// 25002820522). We work around this by copying the GGUF blob with a
// `.bin` suffix appended -- `.bin` is in the framework's accepted
// list, the bundler treats it as a binary asset, and the file is
// pushed to the device verbatim. ggml's `gguf_init_from_file` reads
// by path and parses the GGUF magic bytes; it does not validate the
// file extension, so the rename is purely a packaging detail.
//
// The pair below is `[<source filename in weights/>, <destination
// filename in test/mobile/testAssets/>]`. `resolveModelPath()` in
// `test/integration/utils.js` looks up the destination filename when
// running on mobile.
const WEIGHT_FILES = [
  ['mobilenetv3_3class_v3_fp16.gguf', 'mobilenetv3_3class_v3_fp16.gguf.bin']
]

const ANDROID_FLAVOURS = ['android-arm64', 'android-arm', 'android-ia32', 'android-x64']
const IOS_FLAVOURS = ['ios-arm64', 'ios-arm64-simulator', 'ios-x64-simulator']

function copyDirRecursive (src, dst) {
  if (!fs.existsSync(src)) return false
  fs.mkdirSync(dst, { recursive: true })
  for (const entry of fs.readdirSync(src, { withFileTypes: true })) {
    const sChild = path.join(src, entry.name)
    const dChild = path.join(dst, entry.name)
    if (entry.isDirectory()) {
      copyDirRecursive(sChild, dChild)
    } else if (entry.isFile()) {
      fs.copyFileSync(sChild, dChild)
    }
  }
  return true
}

function fanOutPrebuilds (sourceFlavour, allFlavours) {
  const sourceDir = path.join(PREBUILDS_DIR, sourceFlavour)
  if (!fs.existsSync(sourceDir)) {
    console.log(`[mobile:copy-prebuilds] Source prebuilds not found: ${sourceDir}; skipping fan-out for ${allFlavours.join(', ')}`)
    return
  }
  for (const target of allFlavours) {
    if (target === sourceFlavour) continue
    const targetDir = path.join(PREBUILDS_DIR, target)
    if (fs.existsSync(targetDir)) {
      console.log(`[mobile:copy-prebuilds] ${target} already present, leaving as-is`)
      continue
    }
    if (copyDirRecursive(sourceDir, targetDir)) {
      console.log(`[mobile:copy-prebuilds] Copied ${sourceFlavour} -> ${target}`)
    }
  }
}

function copyWeightsToTestAssets () {
  if (!fs.existsSync(WEIGHTS_DIR)) {
    console.error(`[mobile:copy-prebuilds] FATAL: weights directory not found: ${WEIGHTS_DIR}`)
    console.error('[mobile:copy-prebuilds] The bundled GGUF model must be present before mobile tests can run.')
    process.exit(1)
  }
  fs.mkdirSync(TEST_ASSETS_DIR, { recursive: true })
  let copied = 0
  for (const [srcName, dstName] of WEIGHT_FILES) {
    const src = path.join(WEIGHTS_DIR, srcName)
    const dst = path.join(TEST_ASSETS_DIR, dstName)
    if (!fs.existsSync(src)) {
      console.error(`[mobile:copy-prebuilds] FATAL: required weights file missing: ${src}`)
      process.exit(1)
    }
    fs.copyFileSync(src, dst)
    const sizeMb = (fs.statSync(dst).size / 1024 / 1024).toFixed(1)
    console.log(`[mobile:copy-prebuilds] Copied weights ${srcName} -> ${path.relative(ADDON_DIR, dst)} (${sizeMb} MB)`)
    copied++
  }
  if (copied === 0) {
    console.error('[mobile:copy-prebuilds] FATAL: no weight files were copied')
    process.exit(1)
  }
}

function main () {
  console.log(`[mobile:copy-prebuilds] Preparing mobile assets in ${ADDON_DIR}`)
  fanOutPrebuilds('android-arm64', ANDROID_FLAVOURS)
  fanOutPrebuilds('ios-arm64', IOS_FLAVOURS)
  copyWeightsToTestAssets()
  console.log('[mobile:copy-prebuilds] Done.')
}

main()
