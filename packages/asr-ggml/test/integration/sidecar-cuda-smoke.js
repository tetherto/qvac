'use strict'

// Run directly with bare-sidecar's prebuilds/linux-x64/bare, without the
// integration helpers: their HTTP/crypto dependencies map libstdc++ and mask
// CUDA modules that leave C++ runtime symbols for their host to provide.
// Supply a Whisper model and 16 kHz mono s16le PCM file as arguments.
/* global Bare */
const fs = require('bare-fs')
const path = require('bare-path')
const process = require('bare-process')

function assertNoSharedCxxRuntime(stage) {
  const maps = fs.readFileSync('/proc/self/maps', 'utf8')
  const runtimes = [
    ...new Set(maps.match(/[^\s/]*lib(?:stdc\+\+|c\+\+|c\+\+abi)\.so[^\s/]*$/gm) || [])
  ]
  if (runtimes.length) {
    throw new Error(
      `${stage}: shared C++ runtime mapped (${runtimes.join(', ')}); this host masks the regression`
    )
  }
}

async function main() {
  // Sidecar normally has a parent on fd 3. Keep a direct invocation alive
  // until the assertions finish even when that pipe closes or errors.
  if (Bare.IPC) Bare.IPC.on('error', () => {}).on('close', () => {})
  if (!process.argv[2] || !process.argv[3]) {
    throw new Error('usage: sidecar-cuda-smoke.js <whisper-model> <16khz-s16le.pcm>')
  }
  assertNoSharedCxxRuntime('before loading addon')
  const ASRGgml = require('../../index.js')
  const modelPath = path.resolve(process.argv[2])
  const audio = fs.readFileSync(path.resolve(process.argv[3]))
  if (!audio.length) throw new Error('audio fixture is empty')
  const model = new ASRGgml({
    files: { model: modelPath },
    config: {
      engine: 'whisper',
      path: modelPath,
      contextParams: { use_gpu: true, gpu_device: 0 },
      whisperConfig: { language: 'en', audio_format: 's16le', temperature: 0, n_threads: 4 }
    }
  })
  let stats
  let transcript = ''
  try {
    await model.load()
    assertNoSharedCxxRuntime('after loading model')
    const response = await model.run(new Uint8Array(audio))
    await response
      .onUpdate((output) => {
        for (const segment of Array.isArray(output) ? output : [output]) {
          if (segment && typeof segment.text === 'string') transcript += segment.text
        }
      })
      .await()
    stats = response.stats
  } finally {
    await model.destroy()
  }
  assertNoSharedCxxRuntime('after inference')
  console.log('shared C++ runtimes mapped: none')
  console.log(`backend: ${JSON.stringify(stats)}`)
  console.log(`transcript: ${transcript.trim()}`)
  if (!stats || stats.backendDevice !== 1 || stats.backendId !== 2) {
    throw new Error(
      'CUDA was not selected under bare-sidecar (expected backendDevice=1, backendId=2)'
    )
  }
  if (!transcript.trim()) throw new Error('CUDA inference returned an empty transcript')
}

main().then(
  () => process.exit(0),
  (error) => {
    console.error(error)
    process.exit(1)
  }
)
