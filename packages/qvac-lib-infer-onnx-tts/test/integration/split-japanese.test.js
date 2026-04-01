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

const JAPANESE_LONG_TEXT = `静かな夕暮れ、小さな海辺の町で、ダニエルという名の青年が桟橋の端に立ち、夕焼けの空の下に押し寄せる波を見つめていた。水平線は果てしなく広がり、海と空がほとんど現実とは思えないような繊細な線で交わっていた。彼がこの場所に最後に立ったのはもう何年も前のことだったが、すべてが不思議なほどなじみ深く感じられた。まるで時間が彼のためだけに歩みを緩めたかのように。潮の香りを含んだ風が彼の顔を撫で、記憶の断片を運んできた。子供の頃の笑い声、遠くの声、そしてとうに忘れたと思っていた瞬間の数々。

ダニエルはこの帰還を計画していたわけではなかった。実際、何年もの間、彼は意識的にこの場所を避けていた。代わりに都会の喧騒と気晴らしの中に身を置くことを選んだ。しかし最近、何かが変わった。それは疲れだったのかもしれないし、どれほど遠くに行っても過去から完全に逃れることはできないという静かな気づきだったのかもしれない。彼の一部は常にこの場所に結びついていた。見えない糸のように、優しくも執拗に彼を引き戻す。

桟橋を歩くと、足元の木の板がきしみ、一歩一歩が夕暮れの静けさの中に柔らかく響いた。遠くに古い灯台が高くそびえ立っているのが見えた。その光はゆっくりと回転し、何十年もそうしてきたように忠実に船を導いていた。子供の頃、あの灯台に彼は夢中になったものだ。海の守護者として想像し、遠くに行きすぎたすべての人を見守っていると思っていた。

やがてダニエルは町の中に入った。通りはほとんど人がおらず、いくつかの温かな街灯だけが歩道に長い影を落としていた。ここには彼が忘れていた静けさがあった。空虚ではない沈黙、むしろ語られなかった物語に満ちた沈黙だった。すべての角が思い出を抱えているようであり、すべての建物がかつて知っていた生活を思い起こさせた。

メインストリートの角にある小さなカフェにたどり着いたとき、彼は立ち止まった。ドアの上の看板は少し色あせていたが、まだ読み取れた。両親と一緒にここに来て、窓際に座り、雨が降るのを眺めながらホットチョコレートを飲んだことを覚えている。深く考えずに、彼はドアを押して中に入った。

カフェの温もりがすぐに彼を包んだ。コーヒーと焼きたてのパンの香りが空気に満ち、穏やかな音楽がバックグラウンドで流れていた。カウンターの向こうには、優しい目と穏やかな微笑みを持つ年配の女性が立っていた。彼女はしばらくダニエルを見つめ、少し首をかしげた。まるで記憶の中から彼を見つけようとしているかのように。

「ずいぶん長く離れていたのね」と彼女は静かに言った。

ダニエルはためらった。「僕を知っているんですか」と尋ねた。

女性は再び微笑んだ。「正確には知らないわ。でも多くの人が来ては去るのを見てきたの。あなたは帰ってきた人の顔をしている。」

彼女の言葉が空気の中に漂い、ダニエルは内側で何かが動くのを感じた。彼は何年も前と同じように窓際の小さなテーブルに座った。椅子はなじみ深く、景色は変わっておらず、久しぶりに、急ぐことなくただ座って存在することを自分に許した。

彼らは話し始めた。最初は些細なことだった。天気、町、年月の間に起きた変化について。しかし次第に会話は深くなった。女性は去った人々、残った人々、そしてすべてを結びつける物語について語った。ダニエルは話すよりも聞くことの方が多い自分に気づいた。まるで彼女のすべての言葉が、自分が失っていた何かの欠片を運んでいるかのように。

時間が過ぎていくのに気づかなかった。外では空が完全に暗くなり、星が一つずつ現れ始めた。広がる夜の静かな証人のように。カフェの中では、光は温かく安定したままで、壁の向こうの世界からの小さな避難所を作り出していた。

いつの間にか、ダニエルは自分が背負ってきた重荷、絶え間ないプレッシャー、不確実さ、どこにでもつきまとう静かな不安が薄れ始めていることに気づいた。完全に消えたわけではないが、より軽く、より扱いやすくなっていた。まるでこの場所にいることが、彼の内面の何かをゆっくりと回復させているかのように。

再び外に出たとき、空気はより涼しく感じられたが、同時により澄んでいた。彼はもう一度海の音に引かれて桟橋に戻った。波がリズミカルに動いていた。その動きは安定していて予測可能で、日常生活で慣れ親しんだ混沌とは違っていた。

彼は手すりにもたれかかり、暗闇の中を見つめた。灯台は静かな仕事を続け、その光線が揺るぎない一貫性をもって水面を横切っていた。ダニエルはそのとき気づいた。変わらないものがあるのは、変われないからではなく、変わる必要がないからだと。

成功を追い求めて過ごした年月を思い返した。常に前に進み、なぜそうしているのか自分に問いかけることなく。外から見れば印象的な人生を築いたが、いつの間にか、かつて自分を導いていた意味の感覚を失っていた。

そこに立ち、波の音を聞きながら、彼はシンプルだが深い何かを理解し始めた。探し求めていた答えは、遠い場所や将来の業績の中に隠されていたのではない。それはここにあった。静かな瞬間の中に、決断と決断の間の空間に、懸命に置き去りにしようとした記憶の中に。

穏やかさが彼を包んだ。何年も感じたことのないほど深いものだった。それは興奮でも安堵でもなかった。もっと安定した何か、自分がいる場所への静かな受容と、次にどこに行くかへの穏やかな好奇心だった。

夜は深まり、町は静かなままだった。ダニエルは長い間そこに立ち、水平線を見つめ、考え、思い出していた。そして久しぶりに、彼は何からも逃げようとしていなかった。

潮がゆっくりと満ち、水の音が大きくなると、ダニエルは深呼吸をして目を閉じた。明日はいつものように選択をもたらすだろう。下すべき決断、考慮すべき道、直面すべき不確実さがあるだろう。

しかし今は、そのどれも重要ではなかった。

この瞬間、広大な空の下、果てしなく広がる海を前に、ダニエルはほとんど忘れかけていた何かを感じた。

彼は平和を感じた。

そしてその静かな気づきの中で、彼は理解した。時に、帰郷の旅は場所に戻ることではなく、ようやく逃げることをやめたとき、自分が誰であるかを再発見することなのだと。`

test('Chatterbox Japanese TTS with split: Long narrative', { timeout: 7200000 }, async (t) => {
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
    language: 'ja'
  }

  const model = await loadChatterboxTTS(modelParams)
  t.ok(model, 'Model should be loaded')

  const wavPath = path.join(baseDir, 'test', 'output', 'chatterbox-japanese-split-long.wav')

  const expectation = {
    minSamples: 100000,
    maxSamples: 50000000,
    minDurationMs: 30000,
    maxDurationMs: 1800000
  }

  const startTime = Date.now()

  const result = await runChatterboxTTSWithSplit(
    model,
    { text: JAPANESE_LONG_TEXT, saveWav: true, wavOutputPath: wavPath },
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
  console.log('GENERATION SUMMARY (Japanese)')
  console.log('============================================================')
  console.log(`  Text length:       ${JAPANESE_LONG_TEXT.length} chars`)
  console.log(`  Total samples:     ${result.data.sampleCount}`)
  console.log(`  Audio duration:    ${durationSec.toFixed(1)}s`)
  console.log(`  Processing time:   ${elapsedSec.toFixed(1)}s`)
  console.log(`  Real-time factor:  ${rtf.toFixed(2)}x`)
  console.log('============================================================')

  await model.unload()
})
