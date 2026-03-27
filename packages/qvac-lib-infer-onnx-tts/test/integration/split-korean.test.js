'use strict'

const test = require('brittle')
const os = require('bare-os')
const path = require('bare-path')
const { loadChatterboxTTS, runChatterboxTTSWithSplit } = require('../utils/runChatterboxTTS')
const { ensureChatterboxModels } = require('../utils/downloadModel')

const platform = os.platform()
const isMobile = platform === 'ios' || platform === 'android'

const CHATTERBOX_VARIANT = os.getEnv('CHATTERBOX_VARIANT') || 'fp32'

function getBaseDir () {
  return isMobile && global.testDir ? global.testDir : '.'
}

const KOREAN_LONG_TEXT = `조용한 저녁, 작은 해안 마을에서 다니엘이라는 이름의 젊은 남자가 부두 끝에 서서 저물어가는 주황빛 하늘 아래로 밀려오는 파도를 바라보고 있었다. 수평선은 끝없이 펼쳐져 있었고, 바다와 하늘이 거의 비현실적으로 보이는 가느다란 선으로 만나는 곳이었다. 이곳에 마지막으로 서 있었던 것이 몇 년 전이었지만, 모든 것이 이상하리만치 익숙하게 느껴졌다. 마치 시간이 그를 위해 속도를 늦추기로 결정한 것처럼. 짠 바닷바람이 그의 얼굴을 스치며 기억의 조각들을 가져왔다. 어린 시절의 웃음소리, 먼 목소리, 그리고 오래전에 잊었다고 생각했던 순간들.

다니엘은 이 귀환을 계획하지 않았다. 사실 수년간 그는 의도적으로 이곳을 피해왔으며, 대신 도시의 소음과 분주함 속에 자신을 묻었다. 하지만 최근에 무언가가 변했다. 아마도 피로였을 수도 있고, 아마도 아무리 멀리 떠나도 과거를 완전히 벗어날 수 없다는 조용한 깨달음이었을 수도 있다. 그의 일부는 항상 이 장소에 묶여 있었다. 보이지 않는 실처럼 부드럽지만 끈질기게 그를 다시 끌어당기는.

부두를 따라 걸으며 나무 판자가 그의 발아래에서 삐걱거렸고, 각 걸음이 저녁의 고요함 속으로 부드럽게 울려 퍼졌다. 그는 멀리서 우뚝 솟은 오래된 등대를 보았다. 등대의 불빛이 천천히 회전하며 수십 년 동안 해왔던 것처럼 충실하게 배들을 안내하고 있었다. 그 등대는 어린 시절의 그를 매료시켰다. 그는 그것을 바다의 수호자로 상상하곤 했다. 너무 멀리 나간 모든 이를 지켜보는.

마침내 다니엘은 마을로 들어섰다. 거리는 거의 비어 있었고, 따뜻한 몇 개의 가로등만이 보도 위에 긴 그림자를 드리우고 있었다. 여기에는 그가 잊고 있었던 평온함이 있었다. 공허하지 않은 침묵, 오히려 말하지 않은 이야기들로 가득 찬 침묵이었다. 모든 모퉁이가 기억을 간직하고 있는 것 같았고, 모든 건물이 한때 알았던 삶을 떠올리게 했다.

중심가 모퉁이의 작은 카페에 도착했을 때, 그는 멈춰 섰다. 문 위의 간판은 약간 바랬지만 여전히 알아볼 수 있었다. 그는 부모님과 함께 이곳에 왔던 것을 기억했다. 창가에 앉아 비가 내리는 것을 보며 핫초코를 마셨던. 별생각 없이 그는 문을 밀고 안으로 들어갔다.

카페의 온기가 즉시 그를 감쌌다. 커피와 갓 구운 빵 향이 공기에 가득했고, 배경에서 부드러운 음악이 흘러나왔다. 카운터 뒤에는 따뜻한 눈과 부드러운 미소를 가진 나이 든 여성이 서 있었다. 그녀는 잠시 다니엘을 바라보았다. 고개를 살짝 기울이며 기억 속에서 그를 찾으려는 듯이.

"오랫동안 떠나 있었군요." 그녀가 조용히 말했다.

다니엘은 잠시 머뭇거렸다. "저를 아세요?" 그가 물었다.

여자는 다시 미소 지었다. "정확히는 아닙니다. 하지만 많은 사람이 오고 가는 것을 봤어요. 당신은 돌아온 사람의 모습을 하고 있어요."

그녀의 말이 공기 중에 맴돌았고, 다니엘은 마음속에서 무언가가 움직이는 것을 느꼈다. 그는 예전처럼 창가의 작은 테이블에 앉았다. 의자는 익숙했고, 풍경은 변하지 않았으며, 오랜만에 처음으로 서두르지 않고 그냥 앉아서 존재하는 것을 자신에게 허락했다.

그들은 이야기를 나누기 시작했다. 처음에는 사소한 것들이었다. 날씨, 마을, 수년간의 변화. 하지만 점차 대화가 깊어졌다. 여자는 떠난 사람들, 남은 사람들, 그리고 그들 모두를 연결하는 이야기들을 들려주었다. 다니엘은 자신이 말하기보다 더 많이 듣고 있음을 깨달았다. 마치 그녀의 모든 말이 자신이 잃어버린 무언가의 조각을 담고 있는 것처럼.

시간이 흘러가는 것을 그는 알아차리지 못했다. 밖에서 하늘은 완전히 어두워졌고, 별들이 하나둘 나타나기 시작했다. 펼쳐지는 밤의 조용한 증인들처럼. 카페 안의 불빛은 여전히 따뜻하고 안정적이었다. 벽 너머 세상으로부터의 작은 피난처를 만들어내며.

어느 순간, 다니엘은 자신이 짊어지고 있던 무게가, 그 끊임없는 압박감, 불확실함, 어디를 가든 따라다니던 조용한 불안이 점점 사라지고 있음을 깨달았다. 완전히 사라진 것은 아니었지만, 더 가벼워지고 더 다루기 쉬워진 것이다. 마치 이곳에 있는 것이 그의 내면 어딘가를 천천히 회복시키고 있는 것처럼.

다시 밖으로 나왔을 때, 공기는 더 시원했지만 더 맑게 느껴졌다. 그는 다시 한번 바다 소리에 이끌려 부두로 돌아갔다. 파도가 리듬감 있게 움직이고 있었고, 그 움직임은 그가 일상에서 익숙해진 혼란과 달리 꾸준하고 예측 가능했다.

그는 난간에 기대어 어둠 속을 바라보았다. 등대는 여전히 묵묵히 일하고 있었고, 빛줄기가 흔들림 없이 수면을 가로질러 흘렀다. 다니엘은 그때 깨달았다. 어떤 것들이 변하지 않는 이유는 변할 수 없어서가 아니라 변할 필요가 없기 때문이라는 것을.

그는 성공을 쫓으며 보낸 세월을 떠올렸다. 끊임없이 앞으로 나아가면서도 왜 그러는지 한 번도 자신에게 묻지 않았다. 밖에서 보기에 인상적인 삶을 만들었지만, 어느 사이엔가 자신을 이끌던 의미를 잃어버렸다.

그곳에 서서 파도 소리를 들으며, 그는 단순하지만 깊은 무언가를 이해하기 시작했다. 그가 찾고 있던 답은 먼 곳이나 미래의 성취에 숨겨져 있지 않았다. 그것은 여기에 있었다. 조용한 순간들 속에, 결정들 사이의 공간에, 그가 그토록 뒤에 남기려 했던 기억들 속에.

깊은 평온함이 그를 감쌌다. 그것은 흥분도 아니었고 안도감도 아니었다. 더 안정적인 무언가였다. 자신이 있는 곳에 대한 조용한 수용, 그리고 앞으로 어디로 갈지에 대한 부드러운 호기심.

밤이 깊어지고 마을은 여전히 고요했다. 다니엘은 오래도록 그곳에 서서 수평선을 바라보며 생각하고 기억했다. 그리고 아주 오랜만에 처음으로 그는 무언가로부터 도망치려 하지 않았다.

조수가 천천히 밀려오고 물소리가 커지자, 다니엘은 깊은 숨을 들이쉬고 눈을 감았다. 내일은 언제나 그렇듯 선택을 가져올 것이다. 내려야 할 결정, 고려해야 할 길, 마주해야 할 불확실함이 있을 것이다.

하지만 지금 이 순간, 그 어떤 것도 중요하지 않았다.

광활한 하늘 아래, 끝없이 펼쳐진 바다 앞에서, 다니엘은 거의 잊고 있었던 무언가를 느꼈다.

그는 평화를 느꼈다.

그리고 그 조용한 깨달음 속에서 그는 이해했다. 때로는 집으로 돌아가는 여정이 장소로 돌아가는 것이 아니라, 더 이상 도망치지 않기로 했을 때 비로소 자신이 누구인지를 다시 발견하는 것임을.`

test('Chatterbox Korean TTS with split: Long narrative', { timeout: 7200000 }, async (t) => {
  if (isMobile) {
    t.pass('Skipped on mobile')
    return
  }

  const baseDir = getBaseDir()
  const modelDir = path.join(baseDir, 'models', 'chatterbox-multilingual')

  const downloadResult = await ensureChatterboxModels({ targetDir: modelDir, language: 'multilingual', variant: CHATTERBOX_VARIANT })
  t.ok(downloadResult.success, 'Chatterbox multilingual models should be downloaded')
  if (!downloadResult.success) return

  const modelParams = {
    tokenizerPath: path.join(modelDir, 'tokenizer.json'),
    speechEncoderPath: path.join(modelDir, 'speech_encoder.onnx'),
    embedTokensPath: path.join(modelDir, 'embed_tokens.onnx'),
    conditionalDecoderPath: path.join(modelDir, 'conditional_decoder.onnx'),
    languageModelPath: path.join(modelDir, 'language_model.onnx'),
    language: 'ko'
  }

  const model = await loadChatterboxTTS(modelParams)
  t.ok(model, 'Model should be loaded')

  const wavPath = path.join(baseDir, 'test', 'output', 'chatterbox-korean-split-long.wav')

  const expectation = {
    minSamples: 100000,
    maxSamples: 50000000,
    minDurationMs: 30000,
    maxDurationMs: 1800000
  }

  const startTime = Date.now()

  const result = await runChatterboxTTSWithSplit(
    model,
    { text: KOREAN_LONG_TEXT, saveWav: true, wavOutputPath: wavPath },
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
  console.log('GENERATION SUMMARY (Korean)')
  console.log('============================================================')
  console.log(`  Text length:       ${KOREAN_LONG_TEXT.length} chars`)
  console.log(`  Total samples:     ${result.data.sampleCount}`)
  console.log(`  Audio duration:    ${durationSec.toFixed(1)}s`)
  console.log(`  Processing time:   ${elapsedSec.toFixed(1)}s`)
  console.log(`  Real-time factor:  ${rtf.toFixed(2)}x`)
  console.log('============================================================')

  await model.unload()
})
