#!/usr/bin/env node
// Presigns the OCR models and stages the test images into the mobile test assets, then emits the host pre-stage commands.

import { copyFileSync, mkdirSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { emitPrestage } from '../../../scripts/ci/mobile-prestage.mjs'

const PKG = fileURLToPath(new URL('..', import.meta.url))
const ASSETS = join(PKG, 'test/mobile/testAssets')

// Source image, and the name the mobile suite looks it up by.
export const IMAGES = [
  ['basic_test.bmp', 'basic_test_bmp.bmp'],
  ['basic_test.jpg', 'basic_test_jpg.jpg'],
  ['basic_test.png', 'basic_test_png.png'],
  ['unrecognizable_text.bmp', 'unrecognizable_text.bmp'],
  ['english.bmp', 'english.bmp'],
  ['lab_results.png', 'lab_results.png'],
  ['liver_function_test.png', 'liver_function_test.png'],
  ['clinical_chemistry.png', 'clinical_chemistry.png'],
  ['ct_scan_report.png', 'ct_scan_report.png']
]

const sh = (cmd, args, env = process.env) =>
  execFileSync(cmd, args, { cwd: PKG, stdio: 'inherit', env })

// Advisory, as main ran it.
try {
  sh('npm', ['run', 'test:mobile:validate'])
} catch {
  console.log('::warning::test:mobile:validate failed; the mobile tests may be stale')
}
mkdirSync(ASSETS, { recursive: true })
sh('bash', ['scripts/generate-ocr-ggml-presigned-urls.sh'], { ...process.env, OUTPUT_DIR: ASSETS })
for (const [from, to] of IMAGES) copyFileSync(join(PKG, 'test/images', from), join(ASSETS, to))
emitPrestage(PKG)
