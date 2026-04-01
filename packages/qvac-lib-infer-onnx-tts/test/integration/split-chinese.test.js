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

const CHINESE_LONG_TEXT = `在一个宁静的夜晚，在一个小小的海边小镇上，一个名叫丹尼尔的年轻人站在码头的尽头，望着夕阳下渐渐消失在橙色天空中的海浪。地平线无限延伸，大海与天空在远处交汇成一条几乎不真实的细线。距离他上一次站在这里已经过去了许多年，但一切却显得异常熟悉，仿佛时间为了他而放慢了脚步。咸咸的海风拂过他的脸庞，带来了记忆的碎片——童年的笑声、遥远的呼喊，以及那些他以为早已遗忘的瞬间。

丹尼尔并没有计划回到这里。事实上，多年来他一直刻意回避这个地方，选择沉浸在城市的喧嚣与忙碌之中。但最近，某种东西发生了变化。也许是疲惫，也许是他逐渐意识到，无论走多远，他都无法真正逃离过去。总有一部分的他与这个地方紧密相连，就像一条看不见的线，温柔却坚定地把他拉回来。

当他沿着码头慢慢行走时，木板在脚下轻轻作响，每一步都在寂静的夜晚中回荡。他注意到远处那座古老的灯塔依然矗立，灯光缓缓旋转，像多年前一样，默默指引着远航的船只。小时候，他总是对那座灯塔充满幻想，把它想象成大海的守护者，守望着每一个走得太远的人。

最终，丹尼尔走进了小镇。街道几乎空无一人，只有几盏温暖的路灯照亮着地面，拉出长长的影子。这里的宁静是他早已遗忘的存在——一种不空洞的安静，而是充满了无声故事的安静。每一个角落似乎都承载着回忆，每一栋建筑都提醒着他曾经的生活。

当他走到主街拐角处那家小咖啡馆时，他停了下来。门上的招牌有些褪色，但依然清晰可辨。他记得小时候和父母一起坐在窗边，看着雨滴落下，一边喝着热巧克力。没有多想，他推开门走了进去。

咖啡馆里的温暖立刻包围了他。空气中弥漫着咖啡和新鲜烘焙面包的香气，背景里传来柔和的音乐。柜台后站着一位年长的女人，眼神温和，带着淡淡的微笑。她看了丹尼尔一会儿，微微歪着头，仿佛在记忆中寻找他的影子。

"你离开很久了。"她轻声说道。

丹尼尔有些迟疑。"我们认识吗？"他问。

女人再次微笑。"不完全认识。但我见过很多人来来去去。你看起来像一个回家的人。"

她的话在空气中停留着，让丹尼尔的内心微微震动。他坐在窗边的一张小桌旁，就像多年前那样。椅子依旧熟悉，景色没有改变，而他也终于允许自己停下来，不再匆忙地生活。

他们开始交谈。起初只是一些简单的话题——天气、小镇、这些年的变化。但渐渐地，谈话变得更深。女人讲述着那些离开的人、留下的人，以及把他们联系在一起的故事。丹尼尔发现自己更多地在倾听，仿佛这些话语中藏着他一直缺失的某种东西。

时间悄然流逝。他几乎没有察觉。窗外的天空已经完全变暗，星星一颗一颗地出现，像安静的见证者，注视着夜晚的展开。咖啡馆里的灯光依然温暖而稳定，仿佛是与外界隔绝的一片小小避风港。

不知何时，丹尼尔意识到自己长期背负的压力——那种持续的紧张、不确定，以及始终挥之不去的焦虑——开始慢慢减轻。它并没有完全消失，但变得更轻、更容易承受。仿佛这个地方，正在一点一点修复他内心深处的某些东西。

当他再次走出咖啡馆时，空气变得更加清凉，也更加清晰。他又一次回到了码头，被海浪的声音吸引。海水有节奏地起伏，稳定而可预测，与他习惯的混乱生活形成了鲜明的对比。

他靠在栏杆上，望向远方的黑暗。灯塔依旧默默地运作着，光束不断扫过海面，从未动摇。那一刻，丹尼尔意识到，有些东西之所以不变，并不是因为它们无法改变，而是因为它们本就不需要改变。

他想起这些年来自己对成功的追逐，不断向前，却从未停下来问自己为什么。他建立了一种在外人看来光鲜的生活，但在某个不知不觉的时刻，他失去了曾经指引他的意义。

站在那里，听着海浪的声音，他逐渐明白了一件简单却深刻的事情。他一直寻找的答案，并不在遥远的地方，也不在未来的成就之中。它就在这里，在这些安静的瞬间，在每一个决定之间的空隙，在那些他曾努力遗忘的记忆之中。

一种前所未有的平静在他心中蔓延。这不是兴奋，也不是解脱，而是一种更稳定的感觉——对当下的接受，以及对未来的温柔好奇。

夜色渐深，小镇依旧安静。丹尼尔在那里站了很久，望着地平线，思考，回忆。而这一次，他不再试图逃避任何东西。

随着潮水慢慢上涨，海浪的声音愈发清晰，丹尼尔深吸一口气，闭上了眼睛。明天仍然会带来选择，就像以往一样。仍然会有决定要做，有道路要走，有未知要面对。

但此刻，这一切都不重要。

在这片辽阔的天空之下，在无尽延伸的大海面前，丹尼尔感受到了一种他几乎遗忘的东西。

他感到内心的平静。

而在这份宁静之中，他终于明白，有时候，回家的旅程并不是回到某个地方，而是重新找回那个不再逃避的自己。`

test('Chatterbox Chinese TTS with split: Long narrative', { timeout: 7200000 }, async (t) => {
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
    language: 'zh'
  }

  const model = await loadChatterboxTTS(modelParams)
  t.ok(model, 'Model should be loaded')

  const wavPath = path.join(baseDir, 'test', 'output', 'chatterbox-chinese-split-long.wav')

  const expectation = {
    minSamples: 100000,
    maxSamples: 50000000,
    minDurationMs: 30000,
    maxDurationMs: 1800000
  }

  const startTime = Date.now()

  const result = await runChatterboxTTSWithSplit(
    model,
    { text: CHINESE_LONG_TEXT, saveWav: true, wavOutputPath: wavPath },
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
  console.log('GENERATION SUMMARY (Chinese)')
  console.log('============================================================')
  console.log(`  Text length:       ${CHINESE_LONG_TEXT.length} chars`)
  console.log(`  Total samples:     ${result.data.sampleCount}`)
  console.log(`  Audio duration:    ${durationSec.toFixed(1)}s`)
  console.log(`  Processing time:   ${elapsedSec.toFixed(1)}s`)
  console.log(`  Real-time factor:  ${rtf.toFixed(2)}x`)
  console.log('============================================================')

  await model.unload()
})
