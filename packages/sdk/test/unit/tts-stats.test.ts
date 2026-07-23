import test from 'brittle'
import { collectTtsStats } from '@/server/bare/utils/tts-stats'

test('collectTtsStats: maps LavaSR enhancer backend stats', (t) => {
  const stats = collectTtsStats({
    stats: {
      audioDurationMs: 1200,
      totalSamples: 48000,
      enhancerBackendDevice: 1,
      enhancerBackendId: 3
    }
  })

  t.alike(stats, {
    audioDuration: 1200,
    totalSamples: 48000,
    enhancerBackendDevice: 1,
    enhancerBackendId: 3
  })
})
