import test from 'brittle'
import { buildNmtTranslationStats, NMT_SECONDS_TO_MS } from '@/server/bare/ops/translate-stats'

test('NMT stats: second-valued fields are converted to milliseconds', (t) => {
  const stats = buildNmtTranslationStats({
    totalTime: 1.5,
    decodeTime: 0.75,
    encodeTime: 0.25,
    totalTokens: 42,
    TPS: 28,
    TTFT: 250
  })

  t.is(stats.totalTime, 1.5 * NMT_SECONDS_TO_MS, 'totalTime is scaled to ms')
  t.is(stats.decodeTime, 0.75 * NMT_SECONDS_TO_MS, 'decodeTime is scaled to ms')
  t.is(stats.encodeTime, 0.25 * NMT_SECONDS_TO_MS, 'encodeTime is scaled to ms')
  t.is(stats.tokensPerSecond, 28, 'TPS is not scaled')
  t.is(stats.timeToFirstToken, 250, 'TTFT is already ms and not scaled')
  t.is(stats.totalTokens, 42, 'totalTokens is not scaled')
})

test('NMT stats: absent fields stay absent', (t) => {
  const stats = buildNmtTranslationStats({ totalTime: 2, TPS: 10 })

  t.is(stats.totalTime, 2 * NMT_SECONDS_TO_MS)
  t.is(stats.tokensPerSecond, 10)
  t.absent(stats.decodeTime, 'decodeTime is omitted when the addon did not report it')
  t.absent(stats.encodeTime, 'encodeTime is omitted when the addon did not report it')
  t.absent(stats.timeToFirstToken, 'timeToFirstToken is omitted when the addon did not report it')
  t.absent(stats.totalTokens, 'totalTokens is omitted when the addon did not report it')
})

test('NMT stats: undefined stats produce an empty object', (t) => {
  t.alike(buildNmtTranslationStats(undefined), {})
})
