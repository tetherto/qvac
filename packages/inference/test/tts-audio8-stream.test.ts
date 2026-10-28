import test from 'brittle'
import Buffer from 'bare-buffer'
import { registerModel, unregisterModel } from '@/runtime/model-registry'
import { textToSpeech } from '@/plugins/builtin/tts-ggml/ops/text-to-speech'
import { textToSpeechStream } from '@/plugins/builtin/tts-ggml/ops/text-to-speech-stream'

// Audio8 0.14 emits several codec windows from one sentence. A window must
// reach the caller before synthesis finishes, without a final waveform replay.
for (const mode of ['stream', 'sentence', 'duplex'] as const) {
  test(`Audio8 ${mode}: forwards codec windows before completion without replay`, async (t) => {
    const modelId = `audio8-${mode}`
    let release!: () => void
    const gate = new Promise<void>((resolve) => {
      release = resolve
    })
    const calls: unknown[] = []
    const response = {
      stats: { totalSamples: 4, codecSidecarLoaded: 1, codecOnCoreml: 1 },
      async *iterate() {
        yield { outputArray: new Int16Array([10, 20]), sampleRate: 44100, chunkIndex: 0 }
        await gate
        yield {
          outputArray: new Int16Array([30, 40]),
          sampleRate: 44100,
          chunkIndex: 1,
          isLast: true
        }
      }
    }
    const model = {
      getEngineType: () => 'audio8',
      async cancel() {},
      async run(job: unknown) {
        calls.push(job)
        return response
      },
      async runStream(text: string) {
        calls.push(text)
        return response
      },
      async runStreaming(source: AsyncIterable<string>) {
        for await (const text of source) calls.push(text)
        return response
      }
    }
    registerModel(modelId, {
      model: model as never,
      path: '/tmp/audio8-lm-q8_0.gguf',
      config: { ttsEngine: 'audio8' },
      modelType: 'tts-ggml'
    })
    const op =
      mode === 'duplex'
        ? textToSpeechStream(
            { type: 'textToSpeechStream', modelId, inputType: 'text' },
            (async function* () {
              yield Buffer.from('One unsplit sentence.')
            })()
          )
        : textToSpeech({
            type: 'textToSpeech',
            modelId,
            inputType: 'text',
            text: 'One unsplit sentence.',
            stream: true,
            sentenceStream: mode === 'sentence'
          })
    let timer: ReturnType<typeof setTimeout> | undefined
    try {
      const first = await Promise.race([
        op.next(),
        new Promise<never>((_resolve, reject) => {
          timer = setTimeout(() => reject(new Error('First codec window was buffered')), 1000)
        })
      ])
      clearTimeout(timer)
      t.is(first.done, false)
      t.alike(first.value, { buffer: [10, 20], sampleRate: 44100, chunkIndex: 0 })
      release()
      const second = await op.next()
      t.alike(second.value, {
        buffer: [30, 40],
        sampleRate: 44100,
        chunkIndex: 1,
        isLast: true
      })
      const terminal = await op.next()
      t.is(terminal.done, true, 'no waveform replay after the final codec window')
      if (!terminal.done) throw new Error('Expected terminal stats after the final window')
      t.alike(terminal.value.stats, {
        totalSamples: 4,
        codecSidecarLoaded: 1,
        codecOnCoreml: 1
      })
      t.alike(
        calls,
        mode === 'stream'
          ? [{ input: 'One unsplit sentence.', type: 'text', streamOutput: true }]
          : ['One unsplit sentence.']
      )
    } finally {
      clearTimeout(timer)
      release()
      await op.return({ modelExecutionMs: 0 })
      unregisterModel(modelId)
    }
  })
}
