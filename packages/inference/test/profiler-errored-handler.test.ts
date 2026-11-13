import test from 'brittle'
import { profileReplyHandler } from '@/profiling'

// `loadModel` and `downloadAsset` derive tags from the response. A handler
// that throws has none, and the thrown error must reach the caller unchanged
// instead of a TypeError from the tag extractor.
test('operation profiling: a thrown loadModel error passes through the profiler', async (t) => {
  const failure = new Error('refused')
  await t.exception(
    profileReplyHandler(
      {
        op: 'loadModel',
        request: { type: 'loadModel', modelType: 'whispercpp-transcription' },
        perCall: { enabled: true }
      },
      async () => {
        throw failure
      }
    ),
    /refused/
  )
})
