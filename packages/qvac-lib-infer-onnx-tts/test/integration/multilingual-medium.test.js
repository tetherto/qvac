'use strict'

const test = require('brittle')
const os = require('bare-os')
const path = require('bare-path')
const { loadChatterboxTTS, runChatterboxTTSWithSplit } = require('../utils/runChatterboxTTS')
const { ensureChatterboxModels } = require('../utils/downloadModel')

const platform = os.platform()
const isMobile = platform === 'ios' || platform === 'android'

const CHATTERBOX_VARIANT = os.getEnv('CHATTERBOX_VARIANT') || 'fp32'

function chatterboxLmPath (modelDir) {
  const suffix = CHATTERBOX_VARIANT === 'fp32' ? '' : `_${CHATTERBOX_VARIANT}`
  return path.join(modelDir, `language_model${suffix}.onnx`)
}

function getBaseDir () {
  return isMobile && global.testDir ? global.testDir : '.'
}

const CHATTERBOX_OUTPUT_SAMPLE_RATE_HZ = 24000
const MEDIUM_MIN_AUDIO_SECONDS = 11

const MEDIUM_TEXTS = {
  zh: '今天早晨阳光照进窗户，我感觉精神很好。吃完早餐后，我计划去附近的咖啡店工作一会儿。路上我遇见一位老朋友，我们聊了几分钟。中午我在小餐馆点了一份简单的面条。下午回家的路上我买了一些水果。晚上我想早点休息，明天还有重要的会议。',
  ja: '今朝は窓から明るい光が差し込み、とても清々しい気分でした。朝食のあと、近くのカフェで少し仕事をすることにしました。途中で旧友に会い、立ち話を楽しみました。昼食には小さな店でラーメンを食べました。帰り道に果物を買い、家で家族と穏やかな時間を過ごしました。明日は忙しい一日になりそうですが、今夜はゆっくり休みたいと思います。',
  he: 'היום התעוררתי מוקדם והרגשתי מלא אנרגיה. אחרי ארוחת בוקר קלה יצאתי לריצה קצרה בשכונה. בדרך חזרה פגשתי שכן ודיברנו על מזג האוויר. בצהריים הכנתי סלט ולחם טרי במטבח. אחר הצהריים קראתי מאמר מקצועי והערותי כמה רעיונות חשובים. בערב אני מתכנן לצפות בסדרה ולישון מוקדם כדי להתחיל מחר רענן.',
  ko: '오늘 아침 햇살이 창문으로 들어와 기분이 상쾌했습니다. 아침을 먹은 뒤 근처 카페에서 잠시 일을 하기로 했습니다. 길에서 옛 친구를 만나 잠깐 이야기를 나눴습니다. 점심에는 작은 식당에서 국수를 먹었습니다. 오후에는 과일가게에 들러 사과와 바나나를 샀습니다. 저녁에는 가족과 함께 식사하고 일찍 쉬려고 합니다.'
}

const LANGUAGE_ORDER = ['zh', 'ja', 'he', 'ko']

const EXPECTATION = {
  minSamples: CHATTERBOX_OUTPUT_SAMPLE_RATE_HZ * MEDIUM_MIN_AUDIO_SECONDS,
  maxSamples: 5000000,
  minDurationMs: MEDIUM_MIN_AUDIO_SECONDS * 1000,
  maxDurationMs: 300000
}

for (const lang of LANGUAGE_ORDER) {
  test(`Chatterbox Multilingual TTS [${lang}] medium paragraph`, { timeout: 3600000 }, async (t) => {
    if (isMobile) {
      t.pass('Skipped on mobile')
      return
    }

    const baseDir = getBaseDir()
    const modelDir = path.join(baseDir, 'models', 'chatterbox-multilingual')

    const downloadResult = await ensureChatterboxModels({ targetDir: modelDir, language: 'multilingual', variant: CHATTERBOX_VARIANT })
    t.ok(downloadResult.success, `Models should be available for [${lang}] medium`)
    if (!downloadResult.success) return

    const modelParams = {
      tokenizerPath: path.join(modelDir, 'tokenizer.json'),
      speechEncoderPath: path.join(modelDir, 'speech_encoder.onnx'),
      embedTokensPath: path.join(modelDir, 'embed_tokens.onnx'),
      conditionalDecoderPath: path.join(modelDir, 'conditional_decoder.onnx'),
      languageModelPath: chatterboxLmPath(modelDir),
      language: lang
    }

    const model = await loadChatterboxTTS(modelParams)
    t.ok(model, 'Multilingual TTS model should be loaded')

    const text = MEDIUM_TEXTS[lang]
    const wavPath = path.join(baseDir, 'test', 'output', `chatterbox-multilingual-${lang}-medium.wav`)

    const startTime = Date.now()

    const result = await runChatterboxTTSWithSplit(
      model,
      { text, saveWav: true, wavOutputPath: wavPath },
      EXPECTATION
    )

    const elapsedMs = Date.now() - startTime
    const elapsedSec = elapsedMs / 1000

    console.log(result.output)
    t.ok(result.passed, `[${lang}] medium should pass expectations`)
    t.ok(result.data.sampleCount > 0, `[${lang}] medium should produce audio`)
    t.is(result.data.sampleRate, 24000, `[${lang}] medium sample rate should be 24kHz`)

    const durationSec = result.data.durationMs / 1000
    const rtf = elapsedSec / durationSec

    console.log('\n============================================================')
    console.log(`GENERATION SUMMARY [${lang}] medium`)
    console.log('============================================================')
    console.log(`  Text length:       ${text.length} chars`)
    console.log(`  Total samples:     ${result.data.sampleCount}`)
    console.log(`  Audio duration:    ${durationSec.toFixed(1)}s`)
    console.log(`  Processing time:   ${elapsedSec.toFixed(1)}s`)
    console.log(`  Real-time factor:  ${rtf.toFixed(2)}x`)
    console.log('============================================================')

    await model.unload()
  })
}
