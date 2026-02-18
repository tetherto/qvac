#!/usr/bin/env bare
'use strict'

/**
 * Download models via HyperdriveDL for CI/CD workflows
 *
 * This script replaces S3-based model downloads with peer-to-peer Hyperdrive downloads.
 * Used by CI workflows to fetch models for unit tests, integration tests, and benchmarks.
 *
 * Usage:
 *   bare scripts/download-models-hyperdrive.js --target <target> [options]
 *
 * Targets:
 *   cpp-tests         Download models for C++ unit tests (OPUS en-it, it-en, IndicTrans)
 *   integration       Download models for integration tests (Bergamot en-it, IndicTrans)
 *   bergamot          Download a single Bergamot model for a given language pair
 *   opus              Download a single OPUS/GGML model for a given language pair
 *
 * Options:
 *   --pair <pair>     Language pair (e.g., en-it, en-fr) - required for bergamot/opus targets
 *   --output <dir>    Output directory (default depends on target)
 *   --quantization <q> Quantization type for OPUS: q0f16, q4_0, q0f32 (default: q0f16)
 *
 * Examples:
 *   bare scripts/download-models-hyperdrive.js --target cpp-tests
 *   bare scripts/download-models-hyperdrive.js --target integration
 *   bare scripts/download-models-hyperdrive.js --target bergamot --pair en-it --output ./models/bergamot
 *   bare scripts/download-models-hyperdrive.js --target opus --pair en-fr --quantization q4_0
 */

const HyperdriveDL = require('@qvac/dl-hyperdrive')
const TranslationNmtcpp = require('../index')
const fs = require('bare-fs')
const path = require('bare-path')
const process = require('bare-process')
const { spawnSync } = require('bare-subprocess')

// ============================================================================
// Hyperdrive Keys (from Model Registry)
// ============================================================================

// Bergamot model keys (Firefox Translations format)
const BERGAMOT_KEYS = {
  aren: '152125b9e579de7897bffddc2756a712f1c8e6fcbda162d1a821aab135c8ad7e',
  csen: '41df2dadab7db9a8258d1520ae5815601f5690e0d96ab1e61f931427a679d32d',
  enar: 'c9ae647365e18d8c51eb21c47721544ee3daaaec375913e5ccb7a8d11d493a0c',
  encs: 'c7ccfc55618925351f32b00265375c66309240af9e90f0baf7f460ebc5ba34de',
  enes: 'bf46f9b51d04f5619eea1988499d81cd65268d9b0a60bea0fb647859ffe98a3c',
  enfr: '0a4f388c0449b7774043e5ba8a1a2f735dc22a0a8e01d8bcd593e28db2909abf',
  enit: 'a8811fb494e4aee45ca06a011703a25df5275e5dfa59d6217f2d430c677f9fa6',
  enja: 'ac0b883d176ea3b1d304790efe2d4e4e640a474b7796244c92496fb9d660f29d',
  enpt: '21f12262b8b0440b814f2e57e8224d0921c6cf09e1da0238a4e83789b57ab34f',
  enru: '404279d9716f31913cdb385bef81e940019134b577ed64ae3333b80da75a80bf',
  enzh: '15d484200acea8b19b7eeffd5a96b218c3c437afbed61bfef39dafbae6edfec0',
  esen: 'c3e983c8db3f64faeef8eaf1da9ea4aeb8d5c020529f83957d63c19ed7710651',
  fren: '7a9b38b0c4637b2eab9c11387b8c3f254db64da47cc5a7eecda66513176f7757',
  iten: '3b4be93d19dd9e9e6ee38b528684028ac03c7776563bc0e5ca668b76b0964480',
  jaen: '85012ed3c3ff5c2bfe49faa60ebafb86306e6f2a97f49796374d3069f505bfd3',
  pten: 'a5da4ee5f5817033dee6ed4489d1d3cadcf3d61e99fd246da7e0143c4b7439a4',
  ruen: 'dad7f99c8d8c17233bcfa005f789a0df29bb4ae3116381bdb2a63ffc32c97dfe',
  zhen: '17eb4c3fcd23ac3c93cbe62f08ecb81d70f561f563870ea42494214d6886dd66'
}

// Bergamot model file naming pattern
const BERGAMOT_FILES = {
  // pair code -> { model, vocab } or { model, srcVocab, dstVocab }
  enit: { model: 'model.enit.intgemm.alphas.bin', vocab: 'vocab.enit.spm' },
  iten: { model: 'model.iten.intgemm.alphas.bin', vocab: 'vocab.iten.spm' },
  enes: { model: 'model.enes.intgemm.alphas.bin', vocab: 'vocab.enes.spm' },
  esen: { model: 'model.esen.intgemm.alphas.bin', vocab: 'vocab.esen.spm' },
  enfr: { model: 'model.enfr.intgemm.alphas.bin', vocab: 'vocab.enfr.spm' },
  fren: { model: 'model.fren.intgemm.alphas.bin', vocab: 'vocab.fren.spm' },
  enar: { model: 'model.enar.intgemm.alphas.bin', vocab: 'vocab.enar.spm' },
  aren: { model: 'model.aren.intgemm.alphas.bin', vocab: 'vocab.aren.spm' },
  encs: { model: 'model.encs.intgemm.alphas.bin', vocab: 'vocab.encs.spm' },
  csen: { model: 'model.csen.intgemm.alphas.bin', vocab: 'vocab.csen.spm' },
  enru: { model: 'model.enru.intgemm.alphas.bin', vocab: 'vocab.enru.spm' },
  ruen: { model: 'model.ruen.intgemm.alphas.bin', vocab: 'vocab.ruen.spm' },
  enpt: { model: 'model.enpt.intgemm.alphas.bin', vocab: 'vocab.enpt.spm' },
  pten: { model: 'model.pten.intgemm.alphas.bin', vocab: 'vocab.pten.spm' },
  enja: { model: 'model.enja.intgemm.alphas.bin', srcVocab: 'srcvocab.enja.spm', dstVocab: 'trgvocab.enja.spm' },
  jaen: { model: 'model.jaen.intgemm.alphas.bin', vocab: 'vocab.jaen.spm' },
  enzh: { model: 'model.enzh.intgemm.alphas.bin', srcVocab: 'srcvocab.enzh.spm', dstVocab: 'trgvocab.enzh.spm' },
  zhen: { model: 'model.zhen.intgemm.alphas.bin', vocab: 'vocab.zhen.spm' }
}

// OPUS/GGML model keys by quantization
// IMPORTANT: Only opus-ggml keys are used here (these store model as 'model.bin')
// The opus (non-ggml) keys store in raw Marian format and are NOT compatible
// with direct download as a single model.bin file.
//
// Fallback chain: q4_0 → q0f16 → q0f32 (used when requested quantization
// doesn't have a GGML key for a given pair)
const OPUS_KEYS = {
  // opus-ggml:::q4_0 — only available for French pairs + en-pt
  q4_0: {
    'en-fr': '9cf4a27c1ba14f73d1287dc161b7fd9594253b8e8758bddc961984c1e93d6f5e',
    'fr-en': '688b8d7e82d33c8dd18e156282a1b11e97247d04327e0f7549694f4433861262',
    'fr-de': 'a85185a5747e16cff9db0b2c8ab92b63fbe3c4abc5201c6afa4fd426fabd1cb5',
    'fr-es': '07c3d283e1d22b7a44cb16ed3c733d958885502e293ca75a0b4d87d1aecfc653',
    'de-fr': '3782fc852215514aee043e095c041933bf915f618057035a467f461d844476d3',
    'es-fr': '446daa51a5f037795fce6b0f9b245f53f3f5e601d4dd942b707073bed3586ac4',
    'en-pt': 'a58825b2dcde4c4701889c20050e025df4d69f1161c9d2d2e6106712d70b2ace'
  },
  // opus-ggml:::q0f16
  q0f16: {
    'en-fr': '5b9b65bd8735f91d45103c0b44530823274534230623957db5839c748ba30bf0',
    'fr-en': 'bd1fe00d165a2da2bfb5ea67485602ede700986e40ddd7698b7c37412af01065',
    'fr-de': '14dbccb2c678d45dbd3bd3d0676be9d869b2b6f2ac3fca870f0dcd5a75a0d0d0',
    'fr-es': '710aeacb0e1a0c938478b1e065b06c58be210a8ddb0bc25edb98a809997d2d14',
    'de-fr': '55fe6cf0f6f57e4e5b7ca2b1c544e95f91eb8429d7f056c455e9a8c2677a08fb',
    'es-fr': '2313996f5c2a6265c202c90d07fcbd7f324d166428109abdb16ca11f66305510',
    'en-pt': '098cc786de52e61b8b543f0e0c2e16e054ff19b9f9aef41ec931191c939f8e12',
    'pt-en': '821af2699a40bbec2f2fce6276f59c714285f13780cacae3f023cb44c6c6cad1',
    'en-ru': '65f1ae4ae53764d7f9ae2d1581819b4b3dd6011d30079f4445c5db74c40dd533',
    'ru-en': 'e42148ee7181f908ac2e6ba979d02de96faf330e4f7bad3bf766415657931d48'
  },
  // opus-ggml:::q0f32 — widest coverage
  q0f32: {
    'en-it': '528eb43b34c57b0fb7116e532cd596a9661b001870bdabf696243e8d079a74ca',
    'it-en': 'ee90217a3b0039b48865ec23af102e8a8afafb964ebb45f56f1bed63ac4a0633',
    'en-de': '7f23b4736a1428b60ae665f558ef48d6c70dc2642a4901d3336e02438ea5e752',
    'de-en': 'f60e55fb7859536ea4e2361c5168ce175cb34b251e0ae00b7c8f68ecc0571d0c',
    'en-es': '53760abc441457efbb27047798683723962c9cdb825d645649d50351be326f55',
    'es-en': '73fb3a48ecf2f113710765ba28dd5d5723622f43955d88acbe7f0ec7c7b4d5e2',
    'en-fr': '2957a3e18426d09335d0068efac0726f9945fe72ebbf4161dbc65111c85f6631',
    'fr-en': 'c1226000901bf7e25507b414ffb60e0c8f5cf198de115559dc6bd68826033f20',
    'fr-de': 'd4defd18e51d55eb20957169b2fdfef18627ce01e06d56d40735c429c980a149',
    'fr-es': '6ecc35234eafa3578323591a0872d812479b3937c1a10e303475c9d4614f4ac0',
    'de-fr': '390d1b4164b46d332a82220d83867e1aa19058fb0ccff6d841de792066f992e5',
    'es-fr': 'f43966d16f04b108641de97050563515f699c7426c6aa08f54ee28cbea07a1dd',
    'de-es': 'cd8e6a6b0c306c2594fb2ec80d27d40a749dc9cf49102f0aa9b4f2496568ac53',
    'de-it': '0d534e862018e00a472ba80b5a0a931e5cccc0637578bbe36ce97682fe6a5412',
    'es-de': 'b1029d997c3dc4df757fa7093780e26742297ec093e0fa0c951d49d06f7b7037',
    'es-it': 'd41c61697c19a2b771439101569935129eb39c324e259a6865f825242e60c212',
    'it-de': '6827f57d0aab9dd0194d06bc94cf12ccafe2a5d4d18e72b4bbaa2c3eb30aeea7',
    'it-es': 'd6c7482d24e0e24af399151e22f233e86ca3ced411d5fb892772567b4f625ff5',
    'en-pt': '9eb7a478a6e14aef61f618e531061900a2d9a2d55e693dc464560db92861cba4',
    'en-ru': 'c009326acc2c3eeb5d557489370cf7b6de07d35335cb47e9a3e90909f9ac6c44',
    'ru-en': '12d0af03637c3902beff9bf6e2d854f103ef4745694587c9a67044ff6accb493'
  }
}

/**
 * Resolve an OPUS GGML key for a given pair and quantization.
 * Falls back through q4_0 → q0f16 → q0f32 if the requested quantization
 * doesn't have a GGML key for the pair.
 * @param {string} pair - Language pair (e.g., 'en-it')
 * @param {string} quantization - Requested quantization ('q4_0', 'q0f16', 'q0f32')
 * @returns {{ key: string, actualQuant: string } | null}
 */
function resolveOpusKey (pair, quantization) {
  // Fallback chain: requested → q0f16 → q0f32
  const fallbackChain = [quantization]
  if (quantization === 'q4_0') fallbackChain.push('q0f16', 'q0f32')
  else if (quantization === 'q0f16') fallbackChain.push('q0f32')

  for (const q of fallbackChain) {
    const keys = OPUS_KEYS[q]
    if (keys && keys[pair]) {
      return { key: keys[pair], actualQuant: q }
    }
  }
  return null
}

// IndicTrans model keys
const INDICTRANS_KEYS = {
  'en-indic-200M-q4_0': '8336d23073b2fd99723bf17d65ddc7b54b8ee886d6627659ba95c7a8fb932dc8',
  'en-indic-200M-q0f32': '8c0f50e7c75527213a090d2f1dcd9dbdb8262e5549c8cbbb74cb7cb12b156892'
}

// ============================================================================
// Helper Functions
// ============================================================================

function printHelp () {
  console.log(`
Download models via HyperdriveDL for CI/CD workflows

Usage:
  bare scripts/download-models-hyperdrive.js --target <target> [options]

Targets:
  cpp-tests       Download models for C++ unit tests (OPUS en-it, it-en, IndicTrans)
  integration     Download models for integration tests (Bergamot en-it, IndicTrans)
  bergamot        Download a single Bergamot model for a given language pair
  opus            Download a single OPUS/GGML model for a given language pair

Options:
  --target <t>        Target to download (required)
  --pair <pair>       Language pair, e.g. en-it (required for bergamot/opus)
  --output <dir>      Output directory (default depends on target)
  --quantization <q>  Quantization for OPUS: q4_0, q0f16, q0f32 (default: q0f16)
                      Falls back: q4_0 → q0f16 → q0f32 if key unavailable
  --help              Show this help message

Bergamot Download Strategy:
  • 18 pairs with Hyperdrive keys → P2P download (fastest)
  • All other pairs → fallback to Firefox Translations GitHub via git-lfs
  • Available HD keys: ${Object.keys(BERGAMOT_KEYS).join(', ')}

Examples:
  bare scripts/download-models-hyperdrive.js --target cpp-tests
  bare scripts/download-models-hyperdrive.js --target integration
  bare scripts/download-models-hyperdrive.js --target bergamot --pair en-it --output ./models/bergamot
  bare scripts/download-models-hyperdrive.js --target bergamot --pair en-de --output ./models/bergamot-ende
  bare scripts/download-models-hyperdrive.js --target opus --pair en-fr --quantization q4_0
`)
}

function parseArgs () {
  const args = process.argv.slice(2)
  const options = {
    target: null,
    pair: null,
    output: null,
    quantization: 'q0f16'
  }

  let i = 0
  while (i < args.length) {
    const arg = args[i]
    if (arg === '--help' || arg === '-h') {
      printHelp()
      process.exit(0)
    } else if (arg === '--target' && i + 1 < args.length) {
      options.target = args[i + 1]
      i += 2
    } else if (arg === '--pair' && i + 1 < args.length) {
      options.pair = args[i + 1]
      i += 2
    } else if (arg === '--output' && i + 1 < args.length) {
      options.output = args[i + 1]
      i += 2
    } else if (arg === '--quantization' && i + 1 < args.length) {
      options.quantization = args[i + 1]
      i += 2
    } else {
      console.error(`Unknown option: ${arg}`)
      console.error('Run with --help for usage information')
      process.exit(1)
    }
  }

  return options
}

/**
 * Download a model from Hyperdrive
 * @param {string} hdKey - Hyperdrive key (without hd:// prefix)
 * @param {string} outputDir - Directory to save the file
 * @param {string} hdModelName - Filename as stored in Hyperdrive (e.g., 'model.bin')
 * @param {string} outputName - Desired output filename (e.g., 'ggml-opus-en-it_q4_0.bin')
 * @param {string} label - Human-readable label for logging
 */
async function downloadModel (hdKey, outputDir, hdModelName, outputName, label) {
  console.log(`\n📥 Downloading ${label}...`)
  console.log(`   Hyperdrive key: ${hdKey.substring(0, 16)}...`)
  console.log(`   HD filename: ${hdModelName}`)
  console.log(`   Output: ${outputDir}/${outputName}`)

  fs.mkdirSync(outputDir, { recursive: true })

  const hdDL = new HyperdriveDL({
    key: `hd://${hdKey}`
  })

  const args = {
    loader: hdDL,
    params: { mode: 'full', srcLang: 'en', dstLang: 'it' }, // params needed but not used for download
    diskPath: outputDir,
    modelName: hdModelName // Use the actual Hyperdrive filename
  }

  try {
    const model = new TranslationNmtcpp(args, {})
    await model.load()
    await model.unload()

    // Verify downloaded file exists
    const downloadedPath = path.join(outputDir, hdModelName)
    if (!fs.existsSync(downloadedPath)) {
      console.error(`   ❌ File not found after download: ${downloadedPath}`)
      process.exit(1)
    }

    // Rename to desired output name if different
    const finalPath = path.join(outputDir, outputName)
    if (hdModelName !== outputName) {
      fs.renameSync(downloadedPath, finalPath)
      console.log(`   Renamed: ${hdModelName} → ${outputName}`)
    }

    const stats = fs.statSync(finalPath)
    const sizeMB = (stats.size / (1024 * 1024)).toFixed(1)
    console.log(`   ✅ Downloaded: ${outputName} (${sizeMB}MB)`)
  } finally {
    await hdDL.close()
  }
}

/**
 * Download Bergamot model from Firefox Translations GitHub repo (fallback when no HD key)
 * Uses git sparse-checkout + git-lfs to download only the needed language pair
 * @param {string} pairCode - Language pair code (e.g., 'ende', 'deen')
 * @param {string} outputDir - Directory to save model files
 */
function downloadBergamotFromFirefox (pairCode, outputDir) {
  console.log(`\n📥 Downloading Bergamot ${pairCode} from Firefox Translations GitHub...`)
  console.log(`   (No Hyperdrive key available — using git-lfs fallback)`)

  // Check git and git-lfs are available
  const gitCheck = spawnSync('git', ['--version'], { stdio: 'pipe' })
  if (gitCheck.status !== 0) {
    console.error('❌ git is not installed. Install git to download Firefox models.')
    process.exit(1)
  }

  const lfsCheck = spawnSync('git', ['lfs', 'version'], { stdio: 'pipe' })
  if (lfsCheck.status !== 0) {
    console.error('❌ git-lfs is not installed. Install git-lfs to download Firefox models.')
    console.error('   Ubuntu/Debian: sudo apt-get install git-lfs && git lfs install')
    process.exit(1)
  }

  const tmpDir = `/tmp/firefox-translations-${pairCode}-${Date.now()}`

  try {
    // Sparse clone (downloads only metadata, no blobs)
    console.log('   Cloning Firefox Translations repo (sparse, metadata only)...')
    let result = spawnSync('git', [
      'clone', '--depth', '1', '--filter=blob:none', '--sparse',
      'https://github.com/mozilla/firefox-translations-models.git',
      tmpDir
    ], { stdio: 'pipe' })

    if (result.status !== 0) {
      const stderr = result.stderr ? result.stderr.toString() : ''
      throw new Error(`git clone failed: ${stderr}`)
    }

    // Set sparse checkout to the specific pair directory
    console.log(`   Setting sparse checkout for models/base-memory/${pairCode}...`)
    result = spawnSync('git', [
      '-C', tmpDir, 'sparse-checkout', 'set',
      `models/base-memory/${pairCode}`
    ], { stdio: 'pipe' })

    if (result.status !== 0) {
      throw new Error('git sparse-checkout set failed')
    }

    // Pull LFS files for the specific pair
    console.log('   Pulling LFS files...')
    result = spawnSync('git', [
      '-C', tmpDir, 'lfs', 'pull',
      '--include', `models/base-memory/${pairCode}/*`
    ], { stdio: 'pipe' })

    if (result.status !== 0) {
      throw new Error('git lfs pull failed')
    }

    // Decompress .gz files and copy to output
    const srcDir = path.join(tmpDir, 'models', 'base-memory', pairCode)
    fs.mkdirSync(outputDir, { recursive: true })

    console.log('   Decompressing and copying files...')

    // List all .gz files in the source directory
    const files = fs.readdirSync(srcDir)
    const gzFiles = files.filter(f => f.endsWith('.gz'))

    if (gzFiles.length === 0) {
      throw new Error(`No .gz files found in ${srcDir}. Language pair ${pairCode} may not exist in Firefox Translations.`)
    }

    for (const gzFile of gzFiles) {
      const outputName = gzFile.replace(/\.gz$/, '')
      const gzPath = path.join(srcDir, gzFile)
      const outPath = path.join(outputDir, outputName)

      // Use gunzip to decompress
      const gunzipResult = spawnSync('gunzip', ['-k', '-f', gzPath], { stdio: 'pipe' })
      if (gunzipResult.status !== 0) {
        // Try gzip -d as fallback
        const gzipResult = spawnSync('gzip', ['-d', '-k', '-f', gzPath], { stdio: 'pipe' })
        if (gzipResult.status !== 0) {
          console.error(`   ⚠️  Failed to decompress ${gzFile}`)
          continue
        }
      }

      // Copy decompressed file to output
      const decompressedPath = path.join(srcDir, outputName)
      if (fs.existsSync(decompressedPath)) {
        const data = fs.readFileSync(decompressedPath)
        fs.writeFileSync(outPath, data)
        const sizeMB = (data.length / 1024 / 1024).toFixed(1)
        const sizeKB = (data.length / 1024).toFixed(0)
        const sizeStr = data.length > 1024 * 1024 ? `${sizeMB}MB` : `${sizeKB}KB`
        console.log(`   ✅ ${outputName} (${sizeStr})`)
      }
    }

    console.log(`   ✅ Bergamot ${pairCode} downloaded from Firefox Translations`)
  } finally {
    // Cleanup temp directory
    try {
      spawnSync('rm', ['-rf', tmpDir], { stdio: 'pipe' })
    } catch {
      // Ignore cleanup errors
    }
  }
}

async function downloadBergamotModel (pairCode, outputDir) {
  const hdKey = BERGAMOT_KEYS[pairCode]

  // If we have a Hyperdrive key, use it
  if (hdKey) {
    const fileInfo = BERGAMOT_FILES[pairCode]
    if (!fileInfo) {
      console.error(`❌ No file info for Bergamot pair: ${pairCode}`)
      process.exit(1)
    }

    console.log(`\n📥 Downloading Bergamot ${pairCode} model via Hyperdrive...`)
    console.log(`   Hyperdrive key: ${hdKey.substring(0, 16)}...`)
    console.log(`   Output: ${outputDir}`)

    fs.mkdirSync(outputDir, { recursive: true })

    const hdDL = new HyperdriveDL({
      key: `hd://${hdKey}`
    })

    try {
      await hdDL.ready()

      // Download model file
      console.log(`   Downloading ${fileInfo.model}...`)
      const modelData = await hdDL.download(fileInfo.model)
      fs.writeFileSync(path.join(outputDir, fileInfo.model), modelData)
      console.log(`   ✅ ${fileInfo.model} (${(modelData.length / 1024 / 1024).toFixed(1)}MB)`)

      // Download vocab file(s)
      if (fileInfo.vocab) {
        console.log(`   Downloading ${fileInfo.vocab}...`)
        const vocabData = await hdDL.download(fileInfo.vocab)
        fs.writeFileSync(path.join(outputDir, fileInfo.vocab), vocabData)
        console.log(`   ✅ ${fileInfo.vocab} (${(vocabData.length / 1024).toFixed(0)}KB)`)
      }
      if (fileInfo.srcVocab) {
        console.log(`   Downloading ${fileInfo.srcVocab}...`)
        const srcData = await hdDL.download(fileInfo.srcVocab)
        fs.writeFileSync(path.join(outputDir, fileInfo.srcVocab), srcData)
        console.log(`   ✅ ${fileInfo.srcVocab} (${(srcData.length / 1024).toFixed(0)}KB)`)
      }
      if (fileInfo.dstVocab) {
        console.log(`   Downloading ${fileInfo.dstVocab}...`)
        const dstData = await hdDL.download(fileInfo.dstVocab)
        fs.writeFileSync(path.join(outputDir, fileInfo.dstVocab), dstData)
        console.log(`   ✅ ${fileInfo.dstVocab} (${(dstData.length / 1024).toFixed(0)}KB)`)
      }

      console.log(`   ✅ Bergamot ${pairCode} model downloaded successfully`)
      return
    } catch (err) {
      console.warn(`   ⚠️  Hyperdrive download failed for Bergamot ${pairCode}: ${err.message}`)
      console.warn('   Falling back to Firefox Translations GitHub...')
    } finally {
      await hdDL.close()
    }
  }

  // No Hyperdrive key OR Hyperdrive failed — fallback to Firefox Translations GitHub
  if (!hdKey) {
    console.log(`   No Hyperdrive key for Bergamot ${pairCode}`)
    console.log(`   Available HD keys: ${Object.keys(BERGAMOT_KEYS).join(', ')}`)
  }
  downloadBergamotFromFirefox(pairCode, outputDir)
}

// ============================================================================
// Target: cpp-tests
// Downloads models needed for C++ unit tests
// ============================================================================

async function downloadCppTestModels () {
  console.log('🧪 Downloading models for C++ unit tests...')
  const outputDir = 'models/unit-test'

  // 1. OPUS en-it — no q4_0 GGML key exists, use q0f32 (widest coverage)
  // C++ tests expect ggml-opus-en-it_q4_0.bin; the GGML loader reads ftype from header
  const enitResolved = resolveOpusKey('en-it', 'q4_0')
  if (!enitResolved) {
    console.error('❌ No GGML key for en-it')
    process.exit(1)
  }
  console.log(`   en-it: using ${enitResolved.actualQuant} GGML model`)
  await downloadModel(
    enitResolved.key,
    outputDir,
    'model.bin',
    'ggml-opus-en-it_q4_0.bin',
    `OPUS en→it (${enitResolved.actualQuant})`
  )

  // 2. OPUS it-en — same situation as en-it
  const itenResolved = resolveOpusKey('it-en', 'q4_0')
  if (!itenResolved) {
    console.error('❌ No GGML key for it-en')
    process.exit(1)
  }
  console.log(`   it-en: using ${itenResolved.actualQuant} GGML model`)
  await downloadModel(
    itenResolved.key,
    outputDir,
    'model.bin',
    'ggml-opus-it-en_q4_0.bin',
    `OPUS it→en (${itenResolved.actualQuant})`
  )

  // 3. IndicTrans en-indic 200M q4_0
  await downloadModel(
    INDICTRANS_KEYS['en-indic-200M-q4_0'],
    outputDir,
    'ggml-indictrans2-en-indic-dist-200M.bin',
    'ggml-indictrans2-en-indic-dist-200M-q4_0.bin',
    'IndicTrans2 en→indic 200M (q4_0)'
  )

  console.log('\n✅ All C++ test models downloaded!')
  console.log('Run tests with: ./build/addon/tests/addon-test')
}

// ============================================================================
// Target: integration
// Downloads models needed for desktop integration tests
// ============================================================================

async function downloadIntegrationModels () {
  console.log('🔧 Downloading models for integration tests...')

  // 1. Bergamot en-it
  await downloadBergamotModel('enit', 'model/bergamot/enit')

  // 2. IndicTrans en-indic 200M q4_0
  await downloadModel(
    INDICTRANS_KEYS['en-indic-200M-q4_0'],
    'model/indictrans',
    'ggml-indictrans2-en-indic-dist-200M.bin',
    'ggml-indictrans2-en-indic-dist-200M-q4_0.bin',
    'IndicTrans2 en→indic 200M (q4_0)'
  )

  console.log('\n✅ All integration test models downloaded!')
}

// ============================================================================
// Target: bergamot
// Downloads a single Bergamot model
// ============================================================================

async function downloadSingleBergamot (pair, outputDir) {
  if (!pair) {
    console.error('❌ --pair is required for bergamot target (e.g., --pair en-it)')
    process.exit(1)
  }

  const srcLang = pair.split('-')[0]
  const dstLang = pair.split('-')[1]
  const pairCode = `${srcLang}${dstLang}`

  const dir = outputDir || `models/bergamot/${pairCode}`
  await downloadBergamotModel(pairCode, dir)
}

// ============================================================================
// Target: opus
// Downloads a single OPUS/GGML model
// ============================================================================

async function downloadSingleOpus (pair, outputDir, quantization) {
  if (!pair) {
    console.error('❌ --pair is required for opus target (e.g., --pair en-it)')
    process.exit(1)
  }

  if (!OPUS_KEYS[quantization]) {
    console.error(`❌ Unknown quantization: ${quantization}`)
    console.error(`Available: ${Object.keys(OPUS_KEYS).join(', ')}`)
    process.exit(1)
  }

  const resolved = resolveOpusKey(pair, quantization)
  if (!resolved) {
    console.error(`❌ No GGML Hyperdrive key for OPUS ${pair} (tried: ${quantization} → q0f16 → q0f32)`)
    console.error(`Available q0f32 pairs: ${Object.keys(OPUS_KEYS.q0f32).join(', ')}`)
    process.exit(1)
  }

  if (resolved.actualQuant !== quantization) {
    console.log(`⚠️  No opus-ggml:::${quantization} key for ${pair}, using ${resolved.actualQuant} instead`)
  }

  const dir = outputDir || `qvac_models/${pair}`
  // Output filename reflects the ACTUAL quantization used (not the requested one)
  const outputName = resolved.actualQuant === 'q4_0' ? 'model_q4_0.bin' : (resolved.actualQuant === 'q0f16' ? 'model_f16.bin' : 'model.bin')

  await downloadModel(resolved.key, dir, 'model.bin', outputName, `OPUS ${pair} (${resolved.actualQuant})`)
}

// ============================================================================
// Main
// ============================================================================

async function main () {
  const options = parseArgs()

  if (!options.target) {
    console.error('❌ --target is required')
    console.error('Available targets: cpp-tests, integration, bergamot, opus')
    console.error('Run with --help for usage information')
    process.exit(1)
  }

  const startTime = Date.now()

  switch (options.target) {
    case 'cpp-tests':
      await downloadCppTestModels()
      break
    case 'integration':
      await downloadIntegrationModels()
      break
    case 'bergamot':
      await downloadSingleBergamot(options.pair, options.output)
      break
    case 'opus':
      await downloadSingleOpus(options.pair, options.output, options.quantization)
      break
    default:
      console.error(`❌ Unknown target: ${options.target}`)
      console.error('Available targets: cpp-tests, integration, bergamot, opus')
      process.exit(1)
  }

  const elapsed = ((Date.now() - startTime) / 1000).toFixed(1)
  console.log(`\n⏱️  Total time: ${elapsed}s`)
}

main().catch(err => {
  console.error('Fatal error:', err.message || err)
  process.exit(1)
})

