#!/usr/bin/env node
'use strict'

// Prepares prebuilds and test assets for the on-device mobile test framework.
//
// Two responsibilities:
//
//   1. Fan out the arm64 native prebuilds to the additional platform/arch
//      directory names that the mobile test framework expects to find under
//      `prebuilds/`.
//
//   2. Copy the sample image `samples/english.png` into
//      `test/mobile/testAssets/` so it is available on-device.
//
// GGUF model files are NOT bundled here. Instead, presigned S3 URLs are
// generated at CI time via `scripts/generate-ocr-ggml-presigned-urls.sh`
// and placed in `test/mobile/testAssets/ocr-ggml-model-urls.json`. The
// mobile tests download models on-device from those URLs at runtime.
//
// Idempotent: every action is a copy that overwrites silently.

const fs = require('fs')
const path = require('path')

const ADDON_DIR = path.resolve(__dirname, '..')
const PREBUILDS_DIR = path.join(ADDON_DIR, 'prebuilds')
const SAMPLES_DIR = path.join(ADDON_DIR, 'samples')
const TEST_ASSETS_DIR = path.join(ADDON_DIR, 'test', 'mobile', 'testAssets')

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

function copySampleImageToTestAssets () {
  const src = path.join(SAMPLES_DIR, 'english.png')
  if (!fs.existsSync(src)) {
    console.error(`[mobile:copy-prebuilds] FATAL: sample image not found: ${src}`)
    process.exit(1)
  }
  fs.mkdirSync(TEST_ASSETS_DIR, { recursive: true })
  const dst = path.join(TEST_ASSETS_DIR, 'english.png')
  fs.copyFileSync(src, dst)
  const sizeKb = (fs.statSync(dst).size / 1024).toFixed(1)
  console.log(`[mobile:copy-prebuilds] Copied english.png -> ${path.relative(ADDON_DIR, dst)} (${sizeKb} KB)`)
}

function main () {
  console.log(`[mobile:copy-prebuilds] Preparing mobile assets in ${ADDON_DIR}`)
  fanOutPrebuilds('android-arm64', ANDROID_FLAVOURS)
  fanOutPrebuilds('ios-arm64', IOS_FLAVOURS)
  copySampleImageToTestAssets()
  console.log('[mobile:copy-prebuilds] Done.')
}

main()
