'use strict'

const test = require('brittle')
const os = require('bare-os')
const path = require('bare-path')
const { loadChatterboxTTS, runChatterboxTTS, runChatterboxTTSWithSplit } = require('../utils/runChatterboxTTS')
const { loadSupertonicTTS, runSupertonicTTS } = require('../utils/runSupertonicTTS')
const { ensureChatterboxModels, ensureSupertonicModels, ensureSupertonicModelsMultilingual, ensureWhisperModel } = require('../utils/downloadModel')
const { loadWhisper, runWhisper } = require('../utils/runWhisper')

const platform = os.platform()
const isMobile = platform === 'ios' || platform === 'android'
const isDarwin = platform === 'darwin'

const CHATTERBOX_VARIANT = os.getEnv('CHATTERBOX_VARIANT') || 'fp32'
const VARIANT_SUFFIX = CHATTERBOX_VARIANT === 'fp32' ? '' : `_${CHATTERBOX_VARIANT}`

function chatterboxPath (modelDir, baseName, isMultilingual = false) {
  const suffix = isMultilingual ? '' : VARIANT_SUFFIX
  return path.join(modelDir, `${baseName}${suffix}.onnx`)
}

function chatterboxLmPath (modelDir) {
  return path.join(modelDir, `language_model${VARIANT_SUFFIX}.onnx`)
}

const DATASET = [
  'The quick brown fox jumps over the lazy dog.',
  'How are you doing today?',
  'Artificial intelligence is transforming the world.',
  'The weather is beautiful outside.'
]

function getBaseDir () {
  return isMobile && global.testDir ? global.testDir : '.'
}

test('Chatterbox TTS: Basic synthesis test', { timeout: 1800000 }, async (t) => {
  const baseDir = getBaseDir()
  const modelDir = path.join(baseDir, 'models', 'chatterbox')

  console.log('\n=== Ensuring Chatterbox models ===')
  const downloadResult = await ensureChatterboxModels({ targetDir: modelDir, variant: CHATTERBOX_VARIANT })
  t.ok(downloadResult.success, 'Chatterbox models should be downloaded')
  if (!downloadResult.success) {
    console.log('Failed to download Chatterbox models, skipping test')
    return
  }

  const modelParams = {
    tokenizerPath: path.join(modelDir, 'tokenizer.json'),
    speechEncoderPath: chatterboxPath(modelDir, 'speech_encoder'),
    embedTokensPath: chatterboxPath(modelDir, 'embed_tokens'),
    conditionalDecoderPath: chatterboxPath(modelDir, 'conditional_decoder'),
    languageModelPath: chatterboxLmPath(modelDir),
    language: 'en'
  }

  console.log('\n=== Loading Chatterbox TTS model ===')
  const model = await loadChatterboxTTS(modelParams)
  t.ok(model, 'Chatterbox TTS model should be loaded')
  t.ok(model.addon, 'Addon should be created')

  console.log('\n=== Running Chatterbox TTS synthesis ===')
  const text = 'Hello world! This is a test of the Chatterbox text to speech system.'

  // Note: Synthetic reference audio causes longer outputs than real speech reference
  const expectation = {
    minSamples: 10000,
    maxSamples: 500000,
    minDurationMs: 400,
    maxDurationMs: 20000
  }

  const result = await runChatterboxTTS(model, { text, saveWav: true }, expectation)
  console.log(result.output)

  t.ok(result.passed, 'Chatterbox TTS synthesis should pass expectations')
  t.ok(result.data.sampleCount > 0, 'Chatterbox TTS should produce audio samples')
  t.is(result.data.sampleRate, 24000, 'Sample rate should be 24kHz')

  if (result.data?.stats) {
    console.log(`Inference stats: ${JSON.stringify(result.data.stats)}`)
  }

  // Unload model
  console.log('\n=== Unloading Chatterbox TTS model ===')
  await model.unload()
  t.pass('Model unloaded successfully')

  // Summary
  console.log('\n' + '='.repeat(60))
  console.log('CHATTERBOX BASIC TEST SUMMARY')
  console.log('='.repeat(60))
  console.log(`Text: "${text}"`)
  console.log(`Samples: ${result.data.sampleCount}`)
  console.log(`Duration: ${result.data.durationMs?.toFixed(0) || 'N/A'}ms`)
  console.log(`Sample rate: ${result.data.sampleRate}Hz`)
  if (result.data.stats) {
    console.log(`Total time: ${result.data.stats.totalTime}s`)
    console.log(`Real-time factor: ${result.data.stats.realTimeFactor}`)
    console.log(`Tokens/sec: ${result.data.stats.tokensPerSecond}`)
  }
  console.log('='.repeat(60))
})

test('Chatterbox TTS: Multiple sentences synthesis with WER verification', { timeout: 1800000 }, async (t) => {
  const baseDir = getBaseDir()
  const modelDir = path.join(baseDir, 'models', 'chatterbox')
  const whisperModelDir = path.join(baseDir, 'models', 'whisper')

  console.log('\n=== Ensuring Chatterbox models ===')
  const downloadResult = await ensureChatterboxModels({ targetDir: modelDir, variant: CHATTERBOX_VARIANT })
  t.ok(downloadResult.success, 'Chatterbox models should be downloaded')
  if (!downloadResult.success) {
    console.log('Failed to download Chatterbox models, skipping test')
    return
  }

  if (isDarwin) { // TODO - let it verify WER for all desktop platforms once adding ai-run-linux-gpu and ai-run-windows-gpu runners
    console.log('\n=== Ensuring Whisper model ===')
    const whisperModelPath = path.join(whisperModelDir, 'ggml-small.bin')
    await ensureWhisperModel(whisperModelPath)
    t.pass('Whisper model downloaded')
  } else {
    console.log('\n=== Skipping Whisper model download (non-darwin) ===')
  }

  const modelParams = {
    tokenizerPath: path.join(modelDir, 'tokenizer.json'),
    speechEncoderPath: chatterboxPath(modelDir, 'speech_encoder'),
    embedTokensPath: chatterboxPath(modelDir, 'embed_tokens'),
    conditionalDecoderPath: chatterboxPath(modelDir, 'conditional_decoder'),
    languageModelPath: chatterboxLmPath(modelDir),
    language: 'en'
  }

  const expectation = {
    minSamples: 5000,
    maxSamples: 500000,
    minDurationMs: 200,
    maxDurationMs: 20000
  }

  console.log('\n=== Loading Chatterbox TTS model ===')
  const model = await loadChatterboxTTS(modelParams)
  t.ok(model, 'Chatterbox TTS model should be loaded')

  const results = []

  for (let i = 0; i < DATASET.length; i++) {
    const text = DATASET[i]
    console.log(`\n--- Chatterbox TTS ${i + 1}/${DATASET.length}: "${text}" ---`)

    const result = await runChatterboxTTS(model, { text }, expectation)
    console.log(result.output)

    t.ok(result.passed, `Chatterbox TTS synthesis ${i + 1} should pass expectations`)
    t.ok(result.data.sampleCount > 0, `Chatterbox TTS synthesis ${i + 1} should produce samples`)

    const wavBuffer = result.data?.wavBuffer ? Buffer.from(result.data.wavBuffer) : null
    results.push({
      text,
      sampleCount: result.data.sampleCount,
      durationMs: result.data.durationMs,
      stats: result.data.stats,
      wavBuffer
    })
  }

  // Unload TTS model
  await model.unload()
  console.log('\nChatterbox TTS model unloaded')

  const werResults = []
  if (isDarwin) { // TODO - let it verify WER for all desktop platforms once adding ai-run-linux-gpu and ai-run-windows-gpu runners
    console.log('\n=== Loading Whisper model for WER verification ===')
    const whisperParams = {
      modelName: 'ggml-small.bin',
      diskPath: whisperModelDir,
      language: 'en'
    }
    const whisperModel = await loadWhisper(whisperParams)
    t.ok(whisperModel, 'Whisper model should be loaded')

    // Run WER verification for each synthesized audio
    for (let i = 0; i < results.length; i++) {
      const { text, wavBuffer } = results[i]
      if (!wavBuffer) {
        console.log(`\n--- Whisper ${i + 1}/${results.length}: Skipped (no WAV buffer) ---`)
        continue
      }

      console.log(`\n--- Whisper ${i + 1}/${results.length}: "${text}" ---`)
      const whisperResult = await runWhisper(whisperModel, text, wavBuffer)
      console.log(`>>> [WHISPER] Word Error Rate: ${whisperResult.wer}`)

      t.ok(whisperResult.wer <= 0.4, `WER ${i + 1} should be <= 0.4 (got ${whisperResult.wer})`)
      werResults.push({ text, wer: whisperResult.wer })
    }

    // Unload Whisper model
    await whisperModel.unload()
    console.log('\nWhisper model unloaded')
  } else {
    console.log('\n=== Skipping WER verification (non-darwin) ===')
  }

  // Summary
  console.log('\n' + '='.repeat(60))
  console.log('CHATTERBOX MULTIPLE SENTENCES TEST SUMMARY')
  console.log('='.repeat(60))
  console.log(`Total sentences: ${DATASET.length}`)
  for (let i = 0; i < results.length; i++) {
    const rtf = results[i].stats?.realTimeFactor ?? 'N/A'
    const werInfo = werResults[i] ? `, WER: ${werResults[i].wer}` : ''
    console.log(`  ${i + 1}. "${results[i].text.substring(0, 40)}..." - ${results[i].sampleCount} samples, ${results[i].durationMs?.toFixed(0) || 'N/A'}ms, RTF: ${rtf}${werInfo}`)
  }
  if (werResults.length > 0) {
    const avgWer = werResults.reduce((sum, r) => sum + r.wer, 0) / werResults.length
    console.log(`Average WER: ${avgWer.toFixed(2)}`)
  }
  console.log('='.repeat(60))
})

test('Chatterbox TTS: Reload model from English to Spanish', { timeout: 1800000 }, async (t) => {
  const baseDir = getBaseDir()
  const modelDir = path.join(baseDir, 'models', 'chatterbox')

  console.log('\n=== Ensuring Chatterbox models ===')
  const downloadResult = await ensureChatterboxModels({ targetDir: modelDir, variant: CHATTERBOX_VARIANT })
  t.ok(downloadResult.success, 'Chatterbox models should be downloaded')
  if (!downloadResult.success) {
    console.log('Failed to download Chatterbox models, skipping test')
    return
  }

  const modelParams = {
    tokenizerPath: path.join(modelDir, 'tokenizer.json'),
    speechEncoderPath: chatterboxPath(modelDir, 'speech_encoder'),
    embedTokensPath: chatterboxPath(modelDir, 'embed_tokens'),
    conditionalDecoderPath: chatterboxPath(modelDir, 'conditional_decoder'),
    languageModelPath: chatterboxLmPath(modelDir),
    language: 'en'
  }

  const expectation = {
    minSamples: 5000,
    maxSamples: 5000000,
    minDurationMs: 200,
    maxDurationMs: 300000
  }

  console.log('\n=== Loading Chatterbox TTS model (English) ===')
  const model = await loadChatterboxTTS(modelParams)
  t.ok(model, 'TTS model should be loaded')
  t.ok(model.addon, 'Addon should be created')

  console.log('\n=== Running TTS in English ===')
  const englishText = 'Hello world! This is a test of the text to speech system.'
  // On mobile, skip saveWav since we don't need the output files
  const englishSaveWav = !isMobile
  const englishWavPath = englishSaveWav ? path.join(baseDir, 'test', 'output', 'chatterbox-english-test.wav') : undefined
  const englishResult = await runChatterboxTTS(model, { text: englishText, saveWav: englishSaveWav, wavOutputPath: englishWavPath }, expectation)
  console.log(englishResult.output)
  t.ok(englishResult.passed, 'English TTS should pass expectations')
  t.ok(englishResult.data.sampleCount > 0, 'English TTS should produce audio samples')
  console.log(`English TTS produced ${englishResult.data.sampleCount} samples`)

  console.log('\n=== Reloading model with Spanish language ===')
  await model.reload({ language: 'es' })
  console.log('Model reloaded with Spanish configuration')

  console.log('\n=== Running TTS in Spanish ===')
  const spanishText = 'Hola mundo! Esta es una prueba del sistema de texto a voz.'
  const spanishSaveWav = !isMobile
  const spanishWavPath = spanishSaveWav ? path.join(baseDir, 'test', 'output', 'chatterbox-spanish-test.wav') : undefined
  const spanishResult = await runChatterboxTTS(model, { text: spanishText, saveWav: spanishSaveWav, wavOutputPath: spanishWavPath }, expectation)
  console.log(spanishResult.output)
  t.ok(spanishResult.passed, 'Spanish TTS should pass expectations')
  t.ok(spanishResult.data.sampleCount > 0, 'Spanish TTS should produce audio samples')
  console.log(`Spanish TTS produced ${spanishResult.data.sampleCount} samples`)

  console.log('\n=== Unloading model ===')
  await model.unload()
  t.pass('Model unloaded')

  console.log('\n' + '='.repeat(60))
  console.log('RELOAD MODEL TEST SUMMARY')
  console.log('='.repeat(60))
  console.log(`English TTS: ${englishResult.data.sampleCount} samples, ${englishResult.data.durationMs?.toFixed(0) || 'N/A'}ms`)
  console.log(`Spanish TTS: ${spanishResult.data.sampleCount} samples, ${spanishResult.data.durationMs?.toFixed(0) || 'N/A'}ms`)
  console.log('='.repeat(60))
})

// ---------------------------------------------------------------------------
// Multilingual Chatterbox TTS tests
// ---------------------------------------------------------------------------

const MULTILINGUAL_DATASET = {
  es: 'Hola mundo. Esta es una prueba del sistema de texto a voz.'
}

const MULTILINGUAL_SCRIPT_SAMPLE_ORDER = ['zh', 'ja', 'he', 'ko']
const MULTILINGUAL_SCRIPT_SAMPLES = {
  zh: '你好世界。',
  ja: 'こんにちは。カタカナも使います。',
  he: 'שלום עולם.',
  ko: '안녕하세요. 한글입니다.'
}

const MULTILINGUAL_SCRIPT_SAMPLES_MEDIUM = {
  zh: '今天早晨阳光照进窗户，我感觉精神很好。吃完早餐后，我计划去附近的咖啡店工作一会儿。路上我遇见一位老朋友，我们聊了几分钟。中午我在小餐馆点了一份简单的面条。下午回家的路上我买了一些水果。晚上我想早点休息，明天还有重要的会议。',
  ja: '今朝は窓から明るい光が差し込み、とても清々しい気分でした。朝食のあと、近くのカフェで少し仕事をすることにしました。途中で旧友に会い、立ち話を楽しみました。昼食には小さな店でラーメンを食べました。帰り道に果物を買い、家で家族と穏やかな時間を過ごしました。明日は忙しい一日になりそうですが、今夜はゆっくり休みたいと思います。',
  he: 'היום התעוררתי מוקדם והרגשתי מלא אנרגיה. אחרי ארוחת בוקר קלה יצאתי לריצה קצרה בשכונה. בדרך חזרה פגשתי שכן ודיברנו על מזג האוויר. בצהריים הכנתי סלט ולחם טרי במטבח. אחר הצהריים קראתי מאמר מקצועי והערותי כמה רעיונות חשובים. בערב אני מתכנן לצפות בסדרה ולישון מוקדם כדי להתחיל מחר רענן.',
  ko: '오늘 아침 햇살이 창문으로 들어와 기분이 상쾌했습니다. 아침을 먹은 뒤 근처 카페에서 잠시 일을 하기로 했습니다. 길에서 옛 친구를 만나 잠깐 이야기를 나눴습니다. 점심에는 작은 식당에서 국수를 먹었습니다. 오후에는 과일가게에 들러 사과와 바나나를 샀습니다. 저녁에는 가족과 함께 식사하고 일찍 쉬려고 합니다.'
}

const MULTILINGUAL_SCRIPT_SAMPLES_LONG = {
  zh: '春天悄悄来到这座城市，街道两旁的树木长出了嫩绿的新芽。人们脱下厚外套，在公园里散步、拍照，享受久违的温暖阳光。我喜欢在这个季节早起，泡一杯茶，坐在阳台上读几页书。\n\n上个周末我和家人去了郊外。我们在小山坡上野餐，孩子们放风筝，笑声在山谷里回荡。傍晚时分天空变成粉红色，我们收拾好东西，心满意足地开车回家。\n\n工作方面，最近项目进入了关键阶段。团队每天都在开会讨论方案，虽然辛苦，但大家都很有干劲。我学会了把大任务拆成小步骤，这样压力会小很多。\n\n晚上我喜欢听轻音乐放松，有时会给朋友打电话聊天。生活并不总是完美，但这些平凡的日子让我感到踏实。我期待明天的太阳照常升起。',
  ja: '春が近づき、街路樹の枝に小さな芽が目立ち始めました。人々はコートを脱ぎ、公園で散歩したり写真を撮ったりして、久しぶりの暖かさを楽しんでいます。私も朝早く起きてお茶を淹れ、ベランダで本を読む時間が好きです。\n\n先週末は家族と郊外へ出かけました。小高い丘でピクニックをし、子どもたちは凧を揚げて大喜びでした。夕方には空がピンク色に染まり、片付けをして満足して家路につきました。\n\n仕事では最近プロジェクトが重要な局面に入っています。毎日のように打ち合わせがありますが、チームの士気は高いです。大きな仕事を小さなタスクに分けると、気持ちがずっと楽になります。\n\n夜は静かな音楽を聴いてリラックスし、時々友人に電話します。毎日が完璧ではありませんが、そんな平凡な日々に安心感を覚えます。明日も太陽が昇るのを楽しみにしています。',
  he: 'האביב מגיע בהדרגה לעיר שלנו, והעצים לאורך הרחובות מתחילים להצמיח עלים חדשים וירוקים. אנשים מורידים מעילים כבדים, משוטטים בפארקים ומצלמים תמונות, ונהנים מהשמש החמה שחזרה אחרי החורף. אני אוהב להתעורר מוקדם בעונה הזו, להכין תה ולשבת במרפסת עם ספר.\n\nבסוף השבוע האחרון נסענו עם המשפחה אל הפריפריה. עשינו פיקניק על גבעה קטנה, הילדים העיפו עפיפונים והצחוק התפשט באוויר. לקראת ערב השמיים נצבעו בורוד, ארזנו הכל וחזרנו הביתה ברכב מלאי סיפוק.\n\nבעבודה הפרויקט נכנס לשלב קריטי לאחרונה. יש פגישות כמעט כל יום, אבל לצוות יש מוטיבציה גבוהה. למדתי לחלק משימות גדולות לשלבים קטנים, וזה מפחית מאוד את הלחץ.\n\nבערב אני נוהג להאזין למוזיקה שקטתה ולפעמים להתקשר לחברים. החיים לא מושלמים תמיד, אבל הימים הרגילים האלה נותנים לי יציבות. אני מצפה לשמש שתזרח שוב מחר.',
  ko: '봄이 성큼 다가오면서 거리의 나무들에 연한 새순이 돋아납니다. 사람들은 두꺼운 외투를 벗고 공원에서 산책하고 사진을 찍으며 오랜만에 따뜻한 햇살을 즐깁니다. 저는 이 계절에 일찍 일어나 차 한 잔을 마시며 발코니에서 책을 읽는 시간을 좋아합니다.\n\n지난 주말에는 가족과 교외로 나들이를 갔습니다. 작은 언덕에서 도시락을 먹고 아이들은 연을 날리며 웃었습니다. 해가 질 무렵 하늘이 분홍빛으로 물들었고, 우리는 짐을 챙겨 만족스럽게 집으로 돌아왔습니다.\n\n업무적으로는 요즘 프로젝트가 중요한 국면에 들어섰습니다. 매일 회의가 있지만 팀 분위기는 좋습니다. 큰 일을 작은 단계로 나누면 스트레스가 훨씬 줄어듭니다.\n\n저녁에는 잔잔한 음악을 들으며 쉬고, 가끔 친구에게 전화를 겁니다. 매일이 완벽하진 않지만 이런 평범한 날들이 마음을 든든하게 합니다. 내일도 해가 뜨기를 기다립니다.'
}

const CHATTERBOX_OUTPUT_SAMPLE_RATE_HZ = 24000
const MULTILINGUAL_MEDIUM_MIN_AUDIO_SECONDS = 11
const MULTILINGUAL_LONG_MIN_AUDIO_SECONDS = 14

const MULTILINGUAL_SCRIPT_EXPECTATION_SHORT = {
  minSamples: 5000,
  maxSamples: 5000000,
  minDurationMs: 200,
  maxDurationMs: 300000
}

const MULTILINGUAL_SCRIPT_EXPECTATION_MEDIUM = {
  minSamples: CHATTERBOX_OUTPUT_SAMPLE_RATE_HZ * MULTILINGUAL_MEDIUM_MIN_AUDIO_SECONDS,
  maxSamples: 5000000,
  minDurationMs: MULTILINGUAL_MEDIUM_MIN_AUDIO_SECONDS * 1000,
  maxDurationMs: 300000
}

const MULTILINGUAL_SCRIPT_EXPECTATION_LONG = {
  minSamples: CHATTERBOX_OUTPUT_SAMPLE_RATE_HZ * MULTILINGUAL_LONG_MIN_AUDIO_SECONDS,
  maxSamples: 5000000,
  minDurationMs: MULTILINGUAL_LONG_MIN_AUDIO_SECONDS * 1000,
  maxDurationMs: 300000
}

const MULTILINGUAL_SCRIPT_LOG_PREVIEW_GRAPHEMES = 72

function formatCodePointsForLog (text) {
  const parts = []
  for (const ch of text) {
    const cp = ch.codePointAt(0)
    parts.push(`U+${cp.toString(16).toUpperCase().padStart(4, '0')}(${ch})`)
  }
  return parts.join(' ')
}

function logMultilingualScriptSample (lang, text, opts = {}) {
  const compact = opts.compact === true
  const graphemes = [...text]
  console.log(`\n--- Multilingual script sample [${lang}] ---`)
  console.log(`  Text length: ${text.length} UTF-16 units, ${graphemes.length} graphemes`)
  if (compact && graphemes.length > MULTILINGUAL_SCRIPT_LOG_PREVIEW_GRAPHEMES) {
    const preview = graphemes.slice(0, MULTILINGUAL_SCRIPT_LOG_PREVIEW_GRAPHEMES).join('')
    console.log(`  Text (preview): ${preview}...`)
    console.log(`  Code points (preview): ${formatCodePointsForLog(preview)}...`)
  } else {
    console.log(`  Text: ${text}`)
    console.log(`  Code points: ${formatCodePointsForLog(text)}`)
  }
}

function graphemeCountExceedsPreview (text) {
  return [...text].length > MULTILINGUAL_SCRIPT_LOG_PREVIEW_GRAPHEMES
}

async function runSingleMultilingualScriptCase (t, lang, lengthKey, text, expectation) {
  const baseDir = getBaseDir()
  const modelDir = path.join(baseDir, 'models', 'chatterbox-multilingual')

  console.log('\n=== Ensuring Chatterbox multilingual models + Cangjie table (for zh) ===')
  const downloadResult = await ensureChatterboxModels({ targetDir: modelDir, language: 'multilingual', variant: CHATTERBOX_VARIANT })
  t.ok(downloadResult.success, `Models should be available for [${lang}] ${lengthKey}`)
  if (!downloadResult.success) {
    return
  }

  const modelParams = {
    tokenizerPath: path.join(modelDir, 'tokenizer.json'),
    speechEncoderPath: chatterboxPath(modelDir, 'speech_encoder', true),
    embedTokensPath: chatterboxPath(modelDir, 'embed_tokens', true),
    conditionalDecoderPath: chatterboxPath(modelDir, 'conditional_decoder', true),
    languageModelPath: chatterboxLmPath(modelDir),
    language: lang
  }

  console.log(`\n=== [${lang}] ${lengthKey}: load and synthesize ===`)
  const model = await loadChatterboxTTS(modelParams)
  t.ok(model, 'Multilingual TTS model should be loaded')

  logMultilingualScriptSample(lang, text, { compact: graphemeCountExceedsPreview(text) })

  const saveWav = !isMobile
  const wavPath = saveWav
    ? path.join(baseDir, 'test', 'output', `chatterbox-multilingual-${lang}-${lengthKey}.wav`)
    : undefined
  const useSplit = lengthKey === 'medium' || lengthKey === 'long'
  const synthesize = useSplit ? runChatterboxTTSWithSplit : runChatterboxTTS
  const result = await synthesize(model, { text, saveWav, wavOutputPath: wavPath }, expectation)

  console.log(`\n--- Synthesis [${lang}] ${lengthKey}${useSplit ? ' (split)' : ''} ---`)
  console.log(result.output)
  console.log(`  samples: ${result.data.sampleCount}, durationMs: ${result.data.durationMs?.toFixed(0) ?? 'N/A'}, rate: ${result.data.sampleRate}`)

  t.ok(result.passed, `[${lang}] ${lengthKey} should pass expectations`)
  t.ok(result.data.sampleCount > 0, `[${lang}] ${lengthKey} should produce audio`)
  t.is(result.data.sampleRate, 24000, `[${lang}] ${lengthKey} sample rate should be 24kHz`)

  await model.unload()
}

const MULTILINGUAL_SCRIPT_TEST_SEGMENTS = [
  {
    lengthKey: 'short',
    title: 'short text',
    texts: MULTILINGUAL_SCRIPT_SAMPLES,
    expectation: MULTILINGUAL_SCRIPT_EXPECTATION_SHORT,
    timeoutMs: 3600000
  },
  {
    lengthKey: 'medium',
    title: 'medium paragraph (5–6 sentences)',
    texts: MULTILINGUAL_SCRIPT_SAMPLES_MEDIUM,
    expectation: MULTILINGUAL_SCRIPT_EXPECTATION_MEDIUM,
    timeoutMs: 3600000
  },
  {
    lengthKey: 'long',
    title: 'long text (~4 paragraphs)',
    texts: MULTILINGUAL_SCRIPT_SAMPLES_LONG,
    expectation: MULTILINGUAL_SCRIPT_EXPECTATION_LONG,
    timeoutMs: 7200000
  }
]

for (const segment of MULTILINGUAL_SCRIPT_TEST_SEGMENTS) {
  for (const lang of MULTILINGUAL_SCRIPT_SAMPLE_ORDER) {
    test(
      `Chatterbox Multilingual TTS [${lang}] ${segment.title}`,
      { timeout: segment.timeoutMs },
      async (t) => {
        if (isMobile) {
          t.pass('Skipped on mobile')
          return
        }
        const text = segment.texts[lang]
        await runSingleMultilingualScriptCase(t, lang, segment.lengthKey, text, segment.expectation)
      }
    )
  }
}

test('Chatterbox Multilingual TTS: Synthesis across multiple languages', { timeout: 3600000 }, async (t) => {
  if (isMobile) {
    t.pass('Skipped on mobile')
    return
  }

  const baseDir = getBaseDir()
  const modelDir = path.join(baseDir, 'models', 'chatterbox-multilingual')

  console.log('\n=== Ensuring Chatterbox multilingual models ===')
  const downloadResult = await ensureChatterboxModels({ targetDir: modelDir, language: 'multilingual', variant: CHATTERBOX_VARIANT })
  t.ok(downloadResult.success, 'Chatterbox multilingual models should be downloaded')
  if (!downloadResult.success) {
    console.log('Failed to download Chatterbox multilingual models, skipping test')
    return
  }

  const modelParams = {
    tokenizerPath: path.join(modelDir, 'tokenizer.json'),
    speechEncoderPath: chatterboxPath(modelDir, 'speech_encoder', true),
    embedTokensPath: chatterboxPath(modelDir, 'embed_tokens', true),
    conditionalDecoderPath: chatterboxPath(modelDir, 'conditional_decoder', true),
    languageModelPath: chatterboxLmPath(modelDir),
    language: 'es'
  }

  const expectation = {
    minSamples: 5000,
    maxSamples: 5000000,
    minDurationMs: 200,
    maxDurationMs: 300000
  }

  const languages = Object.keys(MULTILINGUAL_DATASET)
  const firstLang = languages[0]

  console.log(`\n=== Loading Chatterbox multilingual model (${firstLang}) ===`)
  modelParams.language = firstLang
  const model = await loadChatterboxTTS(modelParams)
  t.ok(model, 'Multilingual TTS model should be loaded')
  t.ok(model.addon, 'Addon should be created')

  const results = []

  for (let i = 0; i < languages.length; i++) {
    const lang = languages[i]
    const text = MULTILINGUAL_DATASET[lang]

    if (i > 0) {
      console.log(`\n=== Reloading model for language: ${lang} ===`)
      await model.reload({ language: lang })
    }

    console.log(`\n--- Multilingual TTS [${lang}] ${i + 1}/${languages.length}: "${text}" ---`)

    const saveWav = !isMobile
    const wavPath = saveWav ? path.join(baseDir, 'test', 'output', `chatterbox-multilingual-${lang}.wav`) : undefined
    const result = await runChatterboxTTS(model, { text, saveWav, wavOutputPath: wavPath }, expectation)
    console.log(result.output)

    t.ok(result.passed, `Multilingual TTS [${lang}] should pass expectations`)
    t.ok(result.data.sampleCount > 0, `Multilingual TTS [${lang}] should produce audio samples`)
    t.is(result.data.sampleRate, 24000, `Sample rate for [${lang}] should be 24kHz`)

    results.push({
      lang,
      text,
      sampleCount: result.data.sampleCount,
      durationMs: result.data.durationMs,
      stats: result.data.stats
    })
  }

  console.log('\n=== Unloading multilingual model ===')
  await model.unload()
  t.pass('Model unloaded successfully')

  console.log('\n' + '='.repeat(60))
  console.log('CHATTERBOX MULTILINGUAL TEST SUMMARY')
  console.log('='.repeat(60))
  console.log(`Languages tested: ${languages.join(', ')}`)
  for (const r of results) {
    const rtf = r.stats?.realTimeFactor ?? 'N/A'
    console.log(`  [${r.lang}] "${r.text.substring(0, 40)}..." - ${r.sampleCount} samples, ${r.durationMs?.toFixed(0) || 'N/A'}ms, RTF: ${rtf}`)
  }
  console.log('='.repeat(60))
})

test('Chatterbox Multilingual TTS: WER verification for Spanish', { timeout: 1800000 }, async (t) => {
  if (isMobile) {
    t.pass('Skipped on mobile')
    return
  }

  if (!isDarwin) {
    console.log('WER test skipped (non-darwin)')
    t.pass('WER test skipped (non-darwin)')
    return
  }

  const baseDir = getBaseDir()
  const modelDir = path.join(baseDir, 'models', 'chatterbox-multilingual')
  const whisperModelDir = path.join(baseDir, 'models', 'whisper')

  console.log('\n=== Ensuring Chatterbox multilingual models ===')
  const downloadResult = await ensureChatterboxModels({ targetDir: modelDir, language: 'multilingual', variant: CHATTERBOX_VARIANT })
  t.ok(downloadResult.success, 'Chatterbox multilingual models should be downloaded')
  if (!downloadResult.success) {
    console.log('Failed to download Chatterbox multilingual models, skipping test')
    return
  }

  console.log('\n=== Ensuring Whisper model ===')
  const whisperModelPath = path.join(whisperModelDir, 'ggml-small.bin')
  await ensureWhisperModel(whisperModelPath)

  const modelParams = {
    tokenizerPath: path.join(modelDir, 'tokenizer.json'),
    speechEncoderPath: chatterboxPath(modelDir, 'speech_encoder', true),
    embedTokensPath: chatterboxPath(modelDir, 'embed_tokens', true),
    conditionalDecoderPath: chatterboxPath(modelDir, 'conditional_decoder', true),
    languageModelPath: chatterboxLmPath(modelDir),
    language: 'es'
  }

  const expectation = {
    minSamples: 5000,
    maxSamples: 5000000,
    minDurationMs: 200,
    maxDurationMs: 300000
  }

  const text = 'Hola mundo. Esta es una prueba del sistema de texto a voz.'

  console.log('\n=== Loading Chatterbox multilingual model (es) ===')
  const model = await loadChatterboxTTS(modelParams)
  t.ok(model, 'Multilingual TTS model should be loaded')

  console.log('\n=== Running TTS in Spanish ===')
  const result = await runChatterboxTTS(model, { text }, expectation)
  console.log(result.output)
  t.ok(result.passed, 'Spanish TTS should pass expectations')
  t.ok(result.data.sampleCount > 0, 'Spanish TTS should produce audio samples')

  await model.unload()
  console.log('TTS model unloaded')

  if (!result.data?.wavBuffer) {
    t.fail('No WAV buffer for Whisper verification')
    return
  }

  console.log('\n=== Loading Whisper model for WER verification ===')
  const whisperModel = await loadWhisper({
    modelName: 'ggml-small.bin',
    diskPath: whisperModelDir,
    language: 'es'
  })
  t.ok(whisperModel, 'Whisper model should be loaded')

  const { wer } = await runWhisper(whisperModel, text, result.data.wavBuffer)
  const werPct = (wer * 100).toFixed(1)
  console.log(`>>> [WHISPER] Spanish WER: ${werPct}%`)

  t.ok(wer <= 0.5, `Spanish WER should be <= 50% (got ${werPct}%)`)

  await whisperModel.unload()
  console.log('Whisper model unloaded')

  console.log('\n' + '='.repeat(60))
  console.log('CHATTERBOX MULTILINGUAL WER TEST SUMMARY')
  console.log('='.repeat(60))
  console.log('Language: es')
  console.log(`Text: "${text}"`)
  console.log(`WER: ${werPct}%`)
  console.log('='.repeat(60))
})

// ---------------------------------------------------------------------------
// Supertonic TTS tests
// ---------------------------------------------------------------------------

const SUPERTONIC_SAMPLE_RATE = 44100
const SUPERTONIC_WER_THRESHOLD = 0.3

test('Supertonic TTS: Basic synthesis test', { timeout: 1800000 }, async (t) => {
  const baseDir = getBaseDir()
  const modelDir = path.join(baseDir, 'models', 'supertonic')

  console.log('\n=== Ensuring Supertonic models ===')
  const downloadResult = await ensureSupertonicModels({ targetDir: modelDir })
  t.ok(downloadResult.success, 'Supertonic models should be downloaded')
  if (!downloadResult.success) {
    console.log('Failed to download Supertonic models, skipping test')
    return
  }

  const modelParams = {
    modelDir,
    voiceName: 'F1',
    language: 'en',
    supertonicMultilingual: false
  }

  console.log('\n=== Loading Supertonic TTS model ===')
  const model = await loadSupertonicTTS(modelParams)
  t.ok(model, 'Supertonic TTS model should be loaded')
  t.ok(model.addon, 'Addon should be created')

  console.log('\n=== Running Supertonic TTS synthesis ===')
  const text = 'Hello world! This is a test of the Supertonic text to speech system.'

  const expectation = {
    minSamples: 10000,
    maxSamples: 500000,
    minDurationMs: 400,
    maxDurationMs: 20000
  }

  const saveWav = !isMobile
  const wavOutputPath = saveWav ? path.join(__dirname, '../output/supertonic-test.wav') : undefined
  const result = await runSupertonicTTS(model, { text, saveWav, wavOutputPath }, expectation)
  console.log(result.output)

  t.ok(result.passed, 'Supertonic TTS synthesis should pass expectations')
  t.ok(result.data.sampleCount > 0, 'Supertonic TTS should produce audio samples')
  t.is(SUPERTONIC_SAMPLE_RATE, 44100, 'Supertonic output sample rate is 44.1kHz')

  if (result.data?.stats) {
    console.log(`Inference stats: ${JSON.stringify(result.data.stats)}`)
  }

  console.log('\n=== Unloading Supertonic TTS model ===')
  await model.unload()
  t.pass('Model unloaded successfully')

  console.log('\n' + '='.repeat(60))
  console.log('SUPERTONIC BASIC TEST SUMMARY')
  console.log('='.repeat(60))
  console.log(`Text: "${text}"`)
  console.log(`Samples: ${result.data.sampleCount}`)
  console.log(`Duration: ${result.data.durationMs?.toFixed(0) || 'N/A'}ms`)
  console.log(`Sample rate: ${SUPERTONIC_SAMPLE_RATE}Hz`)
  if (result.data.stats) {
    console.log(`Total time: ${result.data.stats.totalTime}s`)
    console.log(`Real-time factor: ${result.data.stats.realTimeFactor}`)
    console.log(`Tokens/sec: ${result.data.stats.tokensPerSecond}`)
  }
  console.log('='.repeat(60))
})

test('Supertonic TTS: Multiple sentences synthesis', { timeout: 1800000 }, async (t) => {
  const baseDir = getBaseDir()
  const modelDir = path.join(baseDir, 'models', 'supertonic')

  console.log('\n=== Ensuring Supertonic models ===')
  const downloadResult = await ensureSupertonicModels({ targetDir: modelDir })
  t.ok(downloadResult.success, 'Supertonic models should be downloaded')
  if (!downloadResult.success) {
    console.log('Failed to download Supertonic models, skipping test')
    return
  }

  const modelParams = {
    modelDir,
    voiceName: 'F1',
    language: 'en',
    supertonicMultilingual: false
  }

  const expectation = {
    minSamples: 5000,
    maxSamples: 500000,
    minDurationMs: 200,
    maxDurationMs: 20000
  }

  console.log('\n=== Loading Supertonic TTS model ===')
  const model = await loadSupertonicTTS(modelParams)
  t.ok(model, 'Supertonic TTS model should be loaded')

  const results = []

  for (let i = 0; i < DATASET.length; i++) {
    const text = DATASET[i]
    console.log(`\n--- Supertonic TTS ${i + 1}/${DATASET.length}: "${text}" ---`)

    const result = await runSupertonicTTS(model, { text }, expectation)
    console.log(result.output)

    t.ok(result.passed, `Supertonic TTS synthesis ${i + 1} should pass expectations`)
    t.ok(result.data.sampleCount > 0, `Supertonic TTS synthesis ${i + 1} should produce samples`)

    results.push({
      text,
      sampleCount: result.data.sampleCount,
      durationMs: result.data.durationMs,
      stats: result.data.stats
    })
  }

  await model.unload()
  console.log('\nSupertonic TTS model unloaded')

  console.log('\n' + '='.repeat(60))
  console.log('SUPERTONIC MULTIPLE SENTENCES TEST SUMMARY')
  console.log('='.repeat(60))
  console.log(`Total sentences: ${DATASET.length}`)
  for (let i = 0; i < results.length; i++) {
    const rtf = results[i].stats?.realTimeFactor ?? 'N/A'
    console.log(`  ${i + 1}. "${results[i].text.substring(0, 40)}..." - ${results[i].sampleCount} samples, ${results[i].durationMs?.toFixed(0) || 'N/A'}ms, RTF: ${rtf}`)
  }
  console.log('='.repeat(60))
})

test('Supertonic TTS: WER test (TTS + Whisper)', { timeout: 1800000 }, async (t) => {
  if (!isDarwin) {
    console.log('WER test skipped (non-darwin)')
    t.pass('WER test skipped (non-darwin)')
    return
  }

  const baseDir = getBaseDir()
  const modelDir = path.join(baseDir, 'models', 'supertonic')
  const whisperPath = path.join(baseDir, 'models', 'whisper', 'ggml-small.bin')

  console.log('\n=== Ensuring Supertonic models ===')
  const supertonicResult = await ensureSupertonicModels({ targetDir: modelDir })
  t.ok(supertonicResult.success, 'Supertonic models should be downloaded')
  if (!supertonicResult.success) {
    console.log('Failed to download Supertonic models, skipping test')
    return
  }

  console.log('\n=== Ensuring Whisper model ===')
  const whisperResult = await ensureWhisperModel(whisperPath)
  if (!whisperResult.success) {
    t.skip('Whisper model not available - skipping WER test')
    return
  }

  const text = 'The quick brown fox jumps over the lazy dog.'
  const modelParams = { modelDir, voiceName: 'F1', language: 'en', supertonicMultilingual: false }

  console.log('\n=== Loading Supertonic TTS and running synthesis ===')
  const ttsModel = await loadSupertonicTTS(modelParams)
  t.ok(ttsModel, 'Supertonic TTS model should be loaded')

  const ttsResult = await runSupertonicTTS(ttsModel, { text }, {})
  t.ok(ttsResult.passed && ttsResult.data?.wavBuffer, 'TTS should produce WAV')
  await ttsModel.unload()

  if (!ttsResult.data?.wavBuffer) {
    t.fail('No WAV buffer for Whisper')
    return
  }

  console.log('\n=== Loading Whisper and transcribing ===')
  const whisperModel = await loadWhisper({
    modelName: 'ggml-small.bin',
    diskPath: path.join(baseDir, 'models', 'whisper'),
    language: 'en'
  })
  t.ok(whisperModel, 'Whisper model should be loaded')

  const { wer } = await runWhisper(whisperModel, text, ttsResult.data.wavBuffer)
  const werPct = (wer * 100).toFixed(1)

  t.ok(wer <= SUPERTONIC_WER_THRESHOLD, `WER should be <= ${SUPERTONIC_WER_THRESHOLD * 100}%, got ${werPct}%`)
  if (wer > SUPERTONIC_WER_THRESHOLD) {
    console.log(`WER test failed: ${werPct}% > ${SUPERTONIC_WER_THRESHOLD * 100}%`)
  } else {
    console.log(`WER test passed: ${werPct}% <= ${SUPERTONIC_WER_THRESHOLD * 100}%`)
  }

  await whisperModel.unload()
})

test('Supertonic TTS multilingual (Spanish): basic synthesis with HF Supertone/supertonic-2 weights', { timeout: 1800000 }, async (t) => {
  const baseDir = getBaseDir()
  const modelDir = path.join(baseDir, 'models', 'supertonic-multilingual')

  console.log('\n=== Ensuring Supertonic multilingual models (HF supertonic-2) ===')
  const downloadResult = await ensureSupertonicModelsMultilingual({ targetDir: modelDir })
  t.ok(downloadResult.success, 'Supertonic multilingual models should be downloaded')
  if (!downloadResult.success) {
    console.log('Failed to download Supertonic multilingual models, skipping test')
    return
  }

  const modelParams = {
    modelDir,
    voiceName: 'F1',
    language: 'es',
    supertonicMultilingual: true
  }

  console.log('\n=== Loading Supertonic multilingual TTS model ===')
  const model = await loadSupertonicTTS(modelParams)
  t.ok(model, 'Supertonic multilingual TTS model should be loaded')

  const text =
    'Hola mundo. Esta es una prueba del sistema Supertonic de síntesis de voz en español.'
  const expectation = {
    minSamples: 8000,
    maxSamples: 800000,
    minDurationMs: 400,
    maxDurationMs: 30000
  }

  const result = await runSupertonicTTS(model, { text }, expectation)
  t.ok(result.passed, 'Supertonic multilingual Spanish synthesis should pass expectations')
  t.ok(result.data.sampleCount > 0, 'Supertonic multilingual should produce audio samples')

  await model.unload()
  console.log('\nSupertonic multilingual TTS model unloaded')
})
