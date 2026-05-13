'use strict'

/**
 * Bergamot Translation Test
 *
 * This test demonstrates Bergamot translation using a local model.
 * Requires BERGAMOT_MODEL_PATH environment variable to be set.
 *
 * Note: Source language is fixed to English (en). Target language depends on model (e.g., it, es, de, fr).
 *
 * Usage:
 *   BERGAMOT_MODEL_PATH=/path/to/bergamot/model bare test/test-bergamot.js
 *
 * Example:
 *   BERGAMOT_MODEL_PATH=~/.local/share/bergamot/models/firefox/base-memory/enit bare test/test-bergamot.js
 *
 * Environment Variables:
 *   BERGAMOT_MODEL_PATH - Path to Bergamot model directory (required)
 */

const TranslationNmtcpp = require('../index')
const fs = require('bare-fs')
const path = require('bare-path')
const process = require('bare-process')

console.log('[TEST] Starting test-bergamot.js')

// Sample English text to translate (Alice in Wonderland excerpt)
// Note: Source language is fixed to English (en). Target depends on model.
const text = `
  Down, down, down. Would the fall never come to an end? "I wonder how many miles I've fallen by this time?" she said aloud. "I must be getting somewhere near the centre of the earth. Let me see: that would be four thousand miles down. I think—" (for, you see, Alice had learnt several things of this sort in her lessons in the schoolroom, and though this was not a very good opportunity for showing off her knowledge, as there was no one to listen to her, still it was good practice to say it over) "—yes, that's about the right distance—but then I wonder what Latitude or Longitude I've got to?" (Alice had no idea what Latitude was, or Longitude either, but thought they were nice grand words to say.)
  Presently she began again. "I wonder if I shall fall right through the earth! How funny it'll seem to come out among the people that walk with their heads downwards! The Antipathies, I think—" (she was rather glad there was no one listening, this time, as it didn't sound at all the right word) "—but I shall have to ask them what the name of the country is, you know. Please, Ma'am, is this New Zealand or Australia?" (and she tried to curtsey as she spoke—fancy curtseying as you're falling through the air! Do you think you could manage it?) "And what an ignorant little girl she'll think me! No, it'll never do to ask: perhaps I shall see it written up somewhere."
  Down, down, down. There was nothing else to do, so Alice soon began talking again. "Dinah'll miss me very much to-night, I should think!" (Dinah was the cat.) "I hope they'll remember her saucer of milk at tea-time. Dinah, my dear, I wish you were down here with me! There are no mice in the air, I'm afraid, but you might catch a bat, and that's very like a mouse, you know. But do cats eat bats, I wonder?" And here Alice[6] began to get rather sleepy, and went on saying to herself, in a dreamy sort of way, "Do cats eat bats? Do cats eat bats?" and sometimes, "Do bats eat cats?" for, you see, as she couldn't answer either question, it didn't much matter which way she put it. She felt that she was dozing off, and had just begun to dream that she was walking hand in hand with Dinah, and saying to her very earnestly, "Now, Dinah, tell me the truth: did you ever eat a bat?" when suddenly, thump! thump! down she came upon a heap of sticks and dry leaves, and the fall was over.
  Alice was not a bit hurt, and she jumped up on to her feet in a moment: she looked up, but it was all dark overhead; before her was another long passage, and the White Rabbit was still in sight, hurrying down it. There was not a moment to be lost: away went Alice like the wind, and was just in time to hear it say, as it turned a corner, "Oh my ears and whiskers, how late it's getting!" She was close behind it when she turned the corner, but the Rabbit was no longer to be seen: she found herself in a long, low hall, which was lit up by a row of lamps hanging from the roof.
  `

async function main () {
  console.log('[TEST] Entering main function')

  // BERGAMOT_MODEL_PATH is required
  const bergamotPath = process.env.BERGAMOT_MODEL_PATH

  if (!bergamotPath) {
    console.error('[ERROR] BERGAMOT_MODEL_PATH environment variable is required')
    console.error('')
    console.error('Usage:')
    console.error('  BERGAMOT_MODEL_PATH=/path/to/bergamot/model bare test/test-bergamot.js')
    console.error('')
    console.error('Example:')
    console.error('  BERGAMOT_MODEL_PATH=~/.local/share/bergamot/models/firefox/base-memory/enit bare test/test-bergamot.js')
    process.exit(1)
  }

  if (!fs.existsSync(bergamotPath)) {
    console.error('[ERROR] BERGAMOT_MODEL_PATH directory does not exist:', bergamotPath)
    process.exit(1)
  }

  console.log('[TEST] Using local model from:', bergamotPath)

  // Auto-detect model and vocab files
  const files = fs.readdirSync(bergamotPath)
  const modelName = files.find(f => f.includes('.intgemm.') && f.endsWith('.bin'))

  // Try to find vocab files: srcvocab/trgvocab (separate) or vocab (shared)
  let srcVocabName = files.find(f => f.startsWith('srcvocab.') && f.endsWith('.spm'))
  let dstVocabName = files.find(f => (f.startsWith('trgvocab.') || f.startsWith('dstvocab.')) && f.endsWith('.spm'))

  // Fallback to shared vocab file
  if (!srcVocabName) {
    srcVocabName = files.find(f => f.startsWith('vocab.') && f.endsWith('.spm'))
  }
  if (!dstVocabName) {
    dstVocabName = srcVocabName
  }

  if (!modelName || !srcVocabName) {
    console.error('[ERROR] Could not find required model files in:', bergamotPath)
    console.error('[ERROR] Found files:', files.join(', '))
    console.error('')
    console.error('Expected files:')
    console.error('  - model.*.intgemm.*.bin (model weights)')
    console.error('  - vocab.*.spm (shared vocabulary) OR')
    console.error('  - srcvocab.*.spm + trgvocab.*.spm (separate source/target vocabularies)')
    process.exit(1)
  }

  console.log('[TEST] Detected model:', modelName)
  console.log('[TEST] Detected src vocab:', srcVocabName)
  console.log('[TEST] Detected dst vocab:', dstVocabName)

  // Detect language pair and exit if model expects non-English source
  // Model names follow pattern: srcLangtrgLang (e.g., esen = es→en, enit = en→it)
  const pathLower = bergamotPath.toLowerCase()
  const modelLower = modelName.toLowerCase()

  // Extract language pair from path or model name (e.g., "esen", "enit", "enfr")
  const langPairMatch = pathLower.match(/\/(en[a-z]{2}|[a-z]{2}en)(?:\/|$)/) ||
                        modelLower.match(/\.(en[a-z]{2}|[a-z]{2}en)\./)

  let detectedSrcLang = 'en'
  let detectedTrgLang = 'it' // Default fallback

  if (langPairMatch) {
    const langPair = langPairMatch[1]
    detectedSrcLang = langPair.substring(0, 2)
    detectedTrgLang = langPair.substring(2, 4)

    console.log(`[TEST] Detected language pair: ${detectedSrcLang}→${detectedTrgLang}`)

    if (detectedSrcLang !== 'en') {
      console.error('')
      console.error(`[ERROR] ⚠️  Model expects ${detectedSrcLang.toUpperCase()} source input, NOT English!`)
      console.error('[ERROR] This test uses ENGLISH text as input.')
      console.error(`[ERROR] Use an en→X model (e.g., en${detectedSrcLang}) for this test.`)
      console.error('')
      return
    }
  }

  // Create local file loader
  const loader = {
    ready: async () => {},
    close: async () => {},
    download: async (filename) => {
      const filePath = path.join(bergamotPath, filename)
      return fs.readFileSync(filePath)
    },
    getFileSize: async (filename) => {
      const filePath = path.join(bergamotPath, filename)
      const stats = fs.statSync(filePath)
      return stats.size
    }
  }

  const args = {
    loader,
    params: { mode: 'full', dstLang: detectedTrgLang, srcLang: detectedSrcLang },
    diskPath: bergamotPath,
    modelName
  }
  const config = {
    srcVocabName,
    dstVocabName,
    modelType: TranslationNmtcpp.ModelTypes.Bergamot
  }

  console.log('[TEST] Creating TranslationNmtcpp instance')
  const model = new TranslationNmtcpp(args, config)

  console.log('[TEST] Calling model.load()')
  await model.load()
  console.log('[TEST] Model loaded successfully')

  try {
    const response = await model.run(text)

    await response
      .onUpdate(data => {
        console.log(data)
      })
      .await()

    console.log('translation finished!')
  } finally {
    await model.unload()
    await loader.close()
  }
}

console.log('[TEST] Calling main()')
main().catch(console.error)
