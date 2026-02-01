'use strict'

const fs = require('bare-fs')
const process = require('bare-process')
const { VAD } = require('@tetherto/vad-onnx')

const args = process.argv.slice(2)
const [argLaunchDir = 'example'] = args

const audioFilePath = `${argLaunchDir}/sample.bin`

const bitRate = 128000

async function main () {
  const model = new VAD({ params: {} })
  await model.load()

  try {
    const bytesPerSecond = bitRate / 8
    const audioStream = fs.createReadStream(audioFilePath, {
      highWaterMark: bytesPerSecond
    })

    const response = await model.run(audioStream)

    await response.onUpdate((output) => {
      console.log('Partial Transcription Response:', output)
      fs.appendFileSync(`${argLaunchDir}/output2.bin`, Buffer.from(new Uint8Array(output.tsArrayBuffer)))
    }).await()
  } finally {
    await model.unload()
  }
  console.log('Transcription completed.')
}

main().catch(console.error)
