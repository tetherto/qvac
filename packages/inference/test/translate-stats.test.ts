import test from 'brittle'
import { buildNmtTranslationStats, NMT_SECONDS_TO_MS } from '@/plugins/ops/translate-stats'

// The op keys its per-model baseline on the loaded model instance; any object
// stands in for one here.
function model(): object {
  return {}
}

test('NMT stats: second-valued fields are converted to milliseconds', (t) => {
  const stats = buildNmtTranslationStats(
    {
      totalTime: 1.5,
      decodeTime: 0.75,
      encodeTime: 0.25,
      totalTokens: 42,
      TPS: 28,
      TTFT: 250
    },
    model()
  )

  t.is(stats.totalTime, 1.5 * NMT_SECONDS_TO_MS, 'totalTime is scaled to ms')
  t.is(stats.decodeTime, 0.75 * NMT_SECONDS_TO_MS, 'decodeTime is scaled to ms')
  t.is(stats.encodeTime, 0.25 * NMT_SECONDS_TO_MS, 'encodeTime is scaled to ms')
  t.is(stats.tokensPerSecond, 42 / 1.5, 'tokensPerSecond is derived from this request')
  t.is(stats.timeToFirstToken, 250, 'TTFT is already ms and not scaled')
  t.is(stats.totalTokens, 42, 'totalTokens is not scaled')
})

test('NMT stats: absent fields stay absent', (t) => {
  const stats = buildNmtTranslationStats({ totalTime: 2, TPS: 10 }, model())

  t.is(stats.totalTime, 2 * NMT_SECONDS_TO_MS)
  t.absent(stats.tokensPerSecond, 'tokensPerSecond is omitted without a token count')
  t.absent(stats.decodeTime, 'decodeTime is omitted when the addon did not report it')
  t.absent(stats.encodeTime, 'encodeTime is omitted when the addon did not report it')
  t.absent(stats.timeToFirstToken, 'timeToFirstToken is omitted when the addon did not report it')
  t.absent(stats.totalTokens, 'totalTokens is omitted when the addon did not report it')
})

test('NMT stats: undefined stats produce an empty object', (t) => {
  t.alike(buildNmtTranslationStats(undefined, model()), {})
})

test('NMT stats: consecutive requests report their own figures, not the totals', (t) => {
  const nmt = model()

  const first = buildNmtTranslationStats(
    { totalTime: 0.1766, totalTokens: 14, decodeTime: 0.15, TPS: 79 },
    nmt
  )
  const second = buildNmtTranslationStats(
    { totalTime: 0.2004, totalTokens: 24, decodeTime: 0.17, TPS: 120 },
    nmt
  )
  const third = buildNmtTranslationStats(
    { totalTime: 0.2242, totalTokens: 34, decodeTime: 0.19, TPS: 152 },
    nmt
  )

  t.is(second.totalTokens, 10, 'the second request reports its own tokens')
  t.is(third.totalTokens, 10, 'the third request reports its own tokens')
  t.ok(Math.abs(second.totalTime! - 23.8) < 1e-9, 'the second request reports its own time')
  t.ok(Math.abs(third.totalTime! - 23.8) < 1e-9, 'the third request reports its own time')
  t.ok(Math.abs(second.decodeTime! - 20) < 1e-9, 'decodeTime is differenced too')
  t.is(first.totalTokens, 14, 'the first request after load carries the counters as they stand')
})

test('NMT stats: tokensPerSecond does not climb as the load cost amortises', (t) => {
  const nmt = model()

  buildNmtTranslationStats({ totalTime: 1, totalTokens: 10, TPS: 10 }, nmt)
  const second = buildNmtTranslationStats({ totalTime: 2, totalTokens: 20, TPS: 15 }, nmt)
  const third = buildNmtTranslationStats({ totalTime: 3, totalTokens: 30, TPS: 20 }, nmt)

  t.is(second.tokensPerSecond, 10, 'the rate comes from this request')
  t.is(third.tokensPerSecond, 10, 'identical requests report identical rates')
  t.not(third.tokensPerSecond, 20, 'the addon lifetime average is not passed through')
})

test('NMT stats: a reloaded model starts from zero again', (t) => {
  const before = model()
  buildNmtTranslationStats({ totalTime: 5.5676, totalTokens: 8273, TPS: 202 }, before)

  const reloaded = model()
  const afterReload = buildNmtTranslationStats(
    { totalTime: 0.0366, totalTokens: 10, TPS: 79 },
    reloaded
  )

  t.is(afterReload.totalTokens, 10, 'the new instance does not inherit the old counters')
})

test('NMT stats: counters reset in place are read as the request figure', (t) => {
  const nmt = model()

  buildNmtTranslationStats({ totalTime: 5.5676, totalTokens: 8273, TPS: 202 }, nmt)
  const afterReset = buildNmtTranslationStats({ totalTime: 0.036, totalTokens: 10, TPS: 79 }, nmt)

  t.is(afterReset.totalTokens, 10, 'a backwards counter is not reported as a negative delta')
  t.is(afterReset.totalTime, 0.036 * NMT_SECONDS_TO_MS)
})
