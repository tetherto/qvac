'use strict'

const fs = require('bare-fs')
const process = require('bare-process')
const { FFmpegDecoder } = require('..')

const args = process.argv.slice(2)
const [argLaunchDir = 'example'] = args

const audioFilePath = `${argLaunchDir}/sample.ogg`
const outputFilePath = `${argLaunchDir}/decodedFile.raw`

async function main () {
  const decoder = new FFmpegDecoder({
    config: {
      audioFormat: 's16le',
      sampleRate: 16000
    }
  })

  try {
    await decoder.load()

    const audioStream = fs.createReadStream(audioFilePath)

    const response = await decoder.run(audioStream)

    const decodedFileBuffer = []

    await response
      .onUpdate(output => {
        const bytes = new Uint8Array(output.outputArray)
        decodedFileBuffer.push(bytes)
      })
      .onFinish(() => {
        fs.writeFileSync(outputFilePath, Buffer.concat(decodedFileBuffer))
        console.log('Decoded file saved to', outputFilePath)
      })
      .await()
  } finally {
    await decoder.unload()
  }
}

main().catch(console.error)
