'use strict'

const test = require('brittle')
const os = require('bare-os')
const path = require('bare-path')
const { loadChatterboxTTS, runChatterboxTTSWithSplit } = require('../utils/runChatterboxTTS')
const { ensureChatterboxModels } = require('../utils/downloadModel')

const platform = os.platform()
const isMobile = platform === 'ios' || platform === 'android'

const CHATTERBOX_VARIANT = os.getEnv('CHATTERBOX_VARIANT') || 'fp32'
const VARIANT_SUFFIX = CHATTERBOX_VARIANT === 'fp32' ? '' : `_${CHATTERBOX_VARIANT}`

function chatterboxPath (modelDir, baseName) {
  return path.join(modelDir, `${baseName}${VARIANT_SUFFIX}.onnx`)
}

function chatterboxLmPath (modelDir) {
  return path.join(modelDir, `language_model${VARIANT_SUFFIX}.onnx`)
}

function getBaseDir () {
  return isMobile && global.testDir ? global.testDir : '.'
}

const ENGLISH_LONG_TEXT = `On a quiet evening in a small coastal town, a young man named Daniel stood by the edge of the pier, watching the waves roll in under a fading orange sky. The horizon stretched endlessly, where the sea met the sky in a delicate line that seemed almost unreal. It had been years since he last stood in this exact spot, yet everything felt strangely familiar, as if time had decided to slow down just for him. The salty breeze brushed against his face, carrying with it fragments of memory—childhood laughter, distant voices, and moments he thought he had long forgotten.

Daniel had not planned this return. In fact, for years he had actively avoided it, choosing instead the noise and distraction of the city. But something had changed recently. Perhaps it was exhaustion, or perhaps it was the quiet realization that no matter how far he traveled, he could never fully escape the past. There was always a piece of him tied to this place, like an invisible thread pulling him back, gently but persistently.

As he walked along the pier, the wooden planks creaked beneath his feet, each step echoing softly into the stillness of the evening. He noticed the old lighthouse standing tall in the distance, its light rotating slowly, faithfully guiding ships just as it had done for decades. That lighthouse had once fascinated him as a child. He used to imagine it as a guardian of the sea, watching over everything and everyone who dared to venture too far.

Eventually, Daniel made his way into the town. The streets were nearly empty, lit only by a few warm lamps that cast long shadows along the pavement. There was a calmness here that he had forgotten existed—a silence that didn't feel empty, but rather full of unspoken stories. Every corner seemed to hold a memory, every building a reminder of a life he once knew.

When he reached the small café at the corner of the main street, he paused. The sign above the door was slightly faded, but still recognizable. He remembered coming here with his parents, sitting by the window, watching the rain fall while sipping hot chocolate. Without overthinking it, he pushed the door open and stepped inside.

The warmth of the café embraced him immediately. The scent of coffee and baked goods filled the air, and soft music played in the background. Behind the counter stood an elderly woman with kind eyes and a gentle smile. She looked at Daniel for a moment, tilting her head slightly, as if trying to place him in her memory.

"You've been away for quite some time," she said softly.

Daniel hesitated. "Do I know you?" he asked.

The woman smiled again. "Not exactly. But I've seen many people come and go. You have the look of someone returning."

Her words lingered in the air, and Daniel felt something shift inside him. He sat down at a small table near the window, just as he used to years ago. The chair felt familiar, the view unchanged, and for the first time in a long while, he allowed himself to simply sit and exist without rushing.

They began to talk. At first, it was small things—the weather, the town, the changes that had taken place over the years. But gradually, the conversation deepened. The woman spoke about the people who had left, those who had stayed, and the stories that tied them all together. Daniel found himself listening more than speaking, absorbing every word as if it carried a piece of something he had been missing.

Time passed without him noticing. Outside, the sky darkened completely, and the stars began to appear, one by one, like quiet witnesses to the unfolding night. Inside the café, the light remained warm and steady, creating a small refuge from the world beyond its walls.

At some point, Daniel realized that the weight he had been carrying—the constant pressure, the uncertainty, the quiet anxiety that followed him everywhere—had begun to fade. It wasn't gone entirely, but it felt lighter, more manageable. As if being here, in this place, was slowly restoring something within him.

When he finally stepped outside again, the air felt cooler, but also clearer. He made his way back to the pier, drawn once more to the sound of the sea. The waves moved rhythmically, their motion steady and predictable, unlike the chaos he had grown accustomed to in his daily life.

He leaned against the railing and looked out into the darkness. The lighthouse continued its silent work, its beam sweeping across the water with unwavering consistency. Daniel realized then that some things never changed—not because they were unable to, but because they didn't need to.

He thought about the years he had spent chasing success, constantly moving forward without ever stopping to ask himself why. He had built a life that looked impressive from the outside, but somewhere along the way, he had lost the sense of meaning that once guided him.

Standing there, listening to the waves, he began to understand something simple yet profound. The answers he had been searching for were not hidden in distant places or future achievements. They were here, in the quiet moments, in the spaces between decisions, in the memories he had tried so hard to leave behind.

A sense of calm settled over him, deeper than anything he had felt in years. It wasn't excitement, nor was it relief. It was something steadier—a quiet acceptance of where he was, and a gentle curiosity about where he might go next.

The night grew deeper, and the town remained still. Daniel stayed there for a long time, watching the horizon, thinking, remembering. And for the first time in a very long while, he wasn't trying to escape anything.

As the tide slowly rose and the sound of the water grew louder, Daniel took a deep breath and closed his eyes. Tomorrow would bring choices, as it always did. There would be decisions to make, paths to consider, and uncertainties to face.

But for now, none of that mattered.

In this moment, under the vast open sky, with the sea stretching endlessly before him, Daniel felt something he had almost forgotten was possible.

He felt at peace.

And in that quiet realization, he understood that sometimes, the journey back home is not about returning to a place—but about rediscovering who you are when you finally allow yourself to stop running.`

test('Chatterbox English TTS with split: Long article', { timeout: 7200000 }, async (t) => {
  if (isMobile) {
    t.pass('Skipped on mobile')
    return
  }

  const baseDir = getBaseDir()
  const modelDir = path.join(baseDir, 'models', 'chatterbox')

  const downloadResult = await ensureChatterboxModels({ targetDir: modelDir, variant: CHATTERBOX_VARIANT })
  t.ok(downloadResult.success, 'Chatterbox models should be downloaded')
  if (!downloadResult.success) return

  const modelParams = {
    tokenizerPath: path.join(modelDir, 'tokenizer.json'),
    speechEncoderPath: chatterboxPath(modelDir, 'speech_encoder'),
    embedTokensPath: chatterboxPath(modelDir, 'embed_tokens'),
    conditionalDecoderPath: chatterboxPath(modelDir, 'conditional_decoder'),
    languageModelPath: chatterboxLmPath(modelDir),
    language: 'en'
  }

  const model = await loadChatterboxTTS(modelParams)
  t.ok(model, 'Model should be loaded')

  const wavPath = path.join(baseDir, 'test', 'output', 'chatterbox-english-split-long.wav')

  const expectation = {
    minSamples: 100000,
    maxSamples: 50000000,
    minDurationMs: 30000,
    maxDurationMs: 1800000
  }

  const startTime = Date.now()

  const result = await runChatterboxTTSWithSplit(
    model,
    { text: ENGLISH_LONG_TEXT, saveWav: true, wavOutputPath: wavPath },
    expectation
  )

  const elapsedMs = Date.now() - startTime
  const elapsedSec = elapsedMs / 1000

  console.log(result.output)
  t.ok(result.passed, 'Split synthesis should pass expectations')
  t.ok(result.data.sampleCount > 0, 'Should produce audio samples')

  const durationSec = result.data.durationMs / 1000
  const rtf = elapsedSec / durationSec

  console.log('\n============================================================')
  console.log('GENERATION SUMMARY')
  console.log('============================================================')
  console.log(`  Text length:       ${ENGLISH_LONG_TEXT.length} chars`)
  console.log(`  Total samples:     ${result.data.sampleCount}`)
  console.log(`  Audio duration:    ${durationSec.toFixed(1)}s`)
  console.log(`  Processing time:   ${elapsedSec.toFixed(1)}s`)
  console.log(`  Real-time factor:  ${rtf.toFixed(2)}x`)
  console.log('============================================================')

  await model.unload()
})
