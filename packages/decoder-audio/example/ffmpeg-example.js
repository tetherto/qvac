'use strict'

const fs = require('bare-fs')
const { FFmpegDecoder } = require('..')
const process = require('bare-process')

const audioFilePath = './example/sample.ogg' // Assuming this exists from the original repo structure
const outputFilePath = './example/output_ffmpeg.raw'

async function main () {
  console.log('Creating FFmpegDecoder instance...')
  const decoder = new FFmpegDecoder({
    config: {
      audioFormat: 's16le',
      sampleRate: 16000
    }
  })

  try {
    console.log('Loading decoder...')
    await decoder.load()

    console.log('Creating read stream...')
    // Check if sample file exists, if not create a dummy one or fail gracefully
    if (!fs.existsSync(audioFilePath)) {
      console.error(`Audio file not found at ${audioFilePath}`)
      return
    }

    const audioStream = fs.createReadStream(audioFilePath)

    console.log('Running decoder...')
    const response = await decoder.run(audioStream)

    const decodedFileBuffer = []

    await response
      .onUpdate(output => {
        if (output && output.outputArray) {
          const bytes = new Uint8Array(output.outputArray)
          decodedFileBuffer.push(bytes)
          // Optional: print progress
          process.stdout.write('.')
        } else {
          console.error('Received invalid output:', output)
        }
      })
      .onFinish(() => {
        console.log('\nDecoding finished.')
        fs.writeFileSync(outputFilePath, Buffer.concat(decodedFileBuffer))
        console.log('Decoded file saved to', outputFilePath)
      })
      .await()
  } catch (err) {
    console.error('Error:', err)
  } finally {
    console.log('Unloading decoder...')
    await decoder.unload()
  }
}

main().catch(console.error)
