import ASRGgml = require('@qvac/asr-ggml')

const options: ASRGgml.ASRGgmlOptions = {
  files: { model: '/models/model.bin' },
  config: { engine: 'whisper' }
}
const constructor: typeof ASRGgml = ASRGgml
const backend: ASRGgml.BackendInfo = {
  backendDevice: 'CPU',
  backendId: ASRGgml.BackendId.CPU,
  backendName: 'CPU',
  backendDescription: 'CPU',
  encoderBackend: 'CPU',
  encoderOnCoreml: false
}

void [options, constructor, backend]
