'use strict'

/**
 * Long Text Translation Example
 *
 * This example demonstrates translating a long text passage.
 * Note: NMT translation is atomic per-sentence in C++, so pause/resume
 * is not supported. Use cancel() to interrupt a translation.
 *
 * Usage:
 *   bare examples/pause.example.js
 *
 * Enable verbose C++ logging:
 *   VERBOSE=1 bare examples/pause.example.js
 */

const TranslationNmtcpp = require('../index')
const HyperdriveDL = require('@qvac/dl-hyperdrive')
const process = require('bare-process')

// ============================================================
// LOGGING CONFIGURATION
// Set VERBOSE=1 environment variable to enable C++ debug logs
// ============================================================
const VERBOSE = process.env.VERBOSE === '1' || process.env.VERBOSE === 'true'

const logger = VERBOSE
  ? {
      info: (msg) => console.log('[C++ INFO]', msg),
      warn: (msg) => console.warn('[C++ WARN]', msg),
      error: (msg) => console.error('[C++ ERROR]', msg),
      debug: (msg) => console.log('[C++ DEBUG]', msg)
    }
  : null // null = suppress all C++ logs

const text = `
  Down, down, down. Would the fall never come to an end? "I wonder how many miles I've fallen by this time?" she said aloud. "I must be getting somewhere near the centre of the earth. Let me see: that would be four thousand miles down. I think—" (for, you see, Alice had learnt several things of this sort in her lessons in the schoolroom, and though this was not a very good opportunity for showing off her knowledge, as there was no one to listen to her, still it was good practice to say it over) "—yes, that's about the right distance—but then I wonder what Latitude or Longitude I've got to?" (Alice had no idea what Latitude was, or Longitude either, but thought they were nice grand words to say.)
  Presently she began again. "I wonder if I shall fall right through the earth! How funny it'll seem to come out among the people that walk with their heads downwards! The Antipathies, I think—" (she was rather glad there was no one listening, this time, as it didn't sound at all the right word) "—but I shall have to ask them what the name of the country is, you know. Please, Ma'am, is this New Zealand or Australia?" (and she tried to curtsey as she spoke—fancy curtseying as you're falling through the air! Do you think you could manage it?) "And what an ignorant little girl she'll think me! No, it'll never do to ask: perhaps I shall see it written up somewhere."
  Down, down, down. There was nothing else to do, so Alice soon began talking again. "Dinah'll miss me very much to-night, I should think!" (Dinah was the cat.) "I hope they'll remember her saucer of milk at tea-time. Dinah, my dear, I wish you were down here with me! There are no mice in the air, I'm afraid, but you might catch a bat, and that's very like a mouse, you know. But do cats eat bats, I wonder?" And here Alice[6] began to get rather sleepy, and went on saying to herself, in a dreamy sort of way, "Do cats eat bats? Do cats eat bats?" and sometimes, "Do bats eat cats?" for, you see, as she couldn't answer either question, it didn't much matter which way she put it. She felt that she was dozing off, and had just begun to dream that she was walking hand in hand with Dinah, and saying to her very earnestly, "Now, Dinah, tell me the truth: did you ever eat a bat?" when suddenly, thump! thump! down she came upon a heap of sticks and dry leaves, and the fall was over.
  Alice was not a bit hurt, and she jumped up on to her feet in a moment: she looked up, but it was all dark overhead; before her was another long passage, and the White Rabbit was still in sight, hurrying down it. There was not a moment to be lost: away went Alice like the wind, and was just in time to hear it say, as it turned a corner, "Oh my ears and whiskers, how late it's getting!" She was close behind it when she turned the corner, but the Rabbit was no longer to be seen: she found herself in a long, low hall, which was lit up by a row of lamps hanging from the roof.
  `

async function main () {
  const hdDL = new HyperdriveDL({
    // The hyperdrive key for en-it translation model weights and config
    key: 'hd://9ef58f31c20d5556722e0b58a5d262fd89801daf2e6cb28e3f21ac6e9228088f'
  })

  // Create the `args` object
  const args = {
    loader: hdDL,
    params: { mode: 'full', dstLang: 'it', srcLang: 'en' },
    diskPath: './models',
    modelName: 'model.bin',
    logger // Pass logger to enable/disable C++ logs
  }
  const model = new TranslationNmtcpp(args, { })
  await model.load()
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
  }
}

main().catch(console.error)
