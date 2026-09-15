import { loadModel, transcribeStream } from '@/index'

void loadModel({
  modelSrc: '/models/nemotron-3.5-asr-streaming-0.6b.q8_0.gguf',
  modelType: 'parakeet-transcription',
  modelConfig: {
    language: 'en-US',
    streaming: true
    // Deliberately omit streamingChunkMs: Nemotron selects 320 ms natively.
  }
})

void transcribeStream({
  modelId: 'nemotron-test',
  parakeetStreamingConfig: {
    chunkMs: 320,
    emitPartials: true
  }
})
