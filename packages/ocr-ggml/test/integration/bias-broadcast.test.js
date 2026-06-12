'use strict'

const test = require('brittle')
const os = require('bare-os')
const process = require('bare-process')
const { isMobile, platform, getImagePath, ensureModelPath, runOcrComparison } = require('./utils')

const DESKTOP_TIMEOUT = 180 * 1000 // 3 minutes: runs the pipeline twice

// Guards the conv-bias broadcast path (QVAC-20533). The default adds the
// channel bias via ggml_add's implicit broadcast; OCR_GGML_CRAFT_BIAS_REPEAT=1
// forces the legacy ggml_repeat path. The two must be numerically equivalent,
// so this runs the SAME image on the same backend twice — repeat (forced) then
// broadcast (default) — and asserts identical recognized output, plus that each
// pass is absolutely correct.
//
// The toggle is read by the native addon via getenv at graph-build time, so we
// set it through bare-os (which maps to setenv) before constructing the addon
// and restore it afterwards. Desktop POSIX only: mobile device-farm runs don't
// propagate these process env vars, and on Windows uv_os_setenv
// (SetEnvironmentVariableW) does not update the CRT table that the addon's
// std::getenv reads — so the toggle wouldn't take effect and both passes would
// run the default broadcast path, making the comparison vacuous.
const ENV_KEY = 'OCR_GGML_CRAFT_BIAS_REPEAT'

test('EasyOCR conv-bias broadcast matches ggml_repeat (CRAFT)', { timeout: DESKTOP_TIMEOUT }, async function (t) {
  if (isMobile) {
    t.pass('skipped on mobile (env toggle is a desktop-only A/B lever)')
    return
  }
  if (platform === 'win32') {
    t.pass('skipped on win32 (SetEnvironmentVariableW does not reach the addon CRT getenv)')
    return
  }

  const hasGetEnv = typeof os.getEnv === 'function'
  const hasSetEnv = typeof os.setEnv === 'function'
  const prevValue = (hasGetEnv ? os.getEnv(ENV_KEY) : process.env[ENV_KEY]) || ''

  function setEnv (val) {
    if (hasSetEnv) os.setEnv(ENV_KEY, val)
    process.env[ENV_KEY] = val
  }

  function restoreEnv () {
    if (prevValue) {
      setEnv(prevValue)
      return
    }
    if (typeof os.unsetEnv === 'function') os.unsetEnv(ENV_KEY)
    else if (hasSetEnv) os.setEnv(ENV_KEY, '')
    // bare-process's env proxy rejects `delete` (TypeError under strict mode); '' is sufficient since the addon reads via std::getenv.
    process.env[ENV_KEY] = ''
  }

  function assertCorrect (output, tag) {
    t.ok(Array.isArray(output), tag + ': output should be an array')
    t.is(output.length, 3, tag + `: output length should be 3, got ${output.length}`)
    const texts = output.map(o => o[1])
    t.ok(texts.includes('tilted'), tag + ': should contain "tilted"')
    t.ok(texts.includes('normal'), tag + ': should contain "normal"')
    t.ok(texts.includes('vertical'), tag + ': should contain "vertical"')
  }

  try {
    const detectorPath = await ensureModelPath('detector_craft')
    const recognizerPath = await ensureModelPath('recognizer_latin')
    const imagePath = getImagePath('/test/images/basic_test.bmp')
    const baseCfg = {
      params: { pathDetector: detectorPath, pathRecognizer: recognizerPath, langList: ['en'] },
      imagePath,
      runOptions: { paragraph: false },
      perfOpts: { skipReport: true }
    }

    t.comment('Pass A: forced ggml_repeat bias; image: ' + imagePath + ', platform: ' + platform)
    setEnv('1')
    const resRepeat = await runOcrComparison(t, {
      ...baseCfg,
      perfLabel: '[EasyOCR basic_test bias-repeat]',
      assertResult (output) { assertCorrect(output, 'repeat') }
    })
    const outRepeat = resRepeat.output

    t.comment('Pass B: default ggml_add broadcast bias')
    setEnv('')
    const resBroadcast = await runOcrComparison(t, {
      ...baseCfg,
      perfLabel: '[EasyOCR basic_test bias-broadcast]',
      assertResult (output) { assertCorrect(output, 'broadcast') }
    })
    const outBroadcast = resBroadcast.output

    // Equivalence: broadcast must match the ggml_repeat path region-for-region.
    t.is(outBroadcast.length, outRepeat.length, 'broadcast and repeat produce the same number of regions')
    const n = Math.min(outBroadcast.length, outRepeat.length)
    for (let i = 0; i < n; i++) {
      t.is(outBroadcast[i][1], outRepeat[i][1], `region ${i}: broadcast text matches repeat ("${outRepeat[i][1]}")`)
    }

    t.pass('conv-bias broadcast path matches ggml_repeat output')
  } finally {
    restoreEnv()
  }
})
