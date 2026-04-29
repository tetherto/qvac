'use strict'

const fs = require('bare-fs')
const path = require('bare-path')
const process = require('bare-process')
const { FFmpegDecoder } = require('..')

// Input file specified by user
const inputPath = './example/sample.mp3'
// Output file in the current directory
const outputPath = path.join(process.cwd(), './example/sample_mp3.wav')

function writeWavHeader (sampleRate, numChannels, bitsPerSample, dataLength) {
  const byteRate = (sampleRate * numChannels * bitsPerSample) / 8
  const blockAlign = (numChannels * bitsPerSample) / 8
  const buffer = Buffer.alloc(44)

  // RIFF chunk descriptor
  buffer.write('RIFF', 0)
  buffer.writeUInt32LE(36 + dataLength, 4) // ChunkSize
  buffer.write('WAVE', 8)

  // fmt sub-chunk
  buffer.write('fmt ', 12)
  buffer.writeUInt32LE(16, 16) // Subchunk1Size (16 for PCM)
  buffer.writeUInt16LE(1, 20) // AudioFormat (1 for PCM)
  buffer.writeUInt16LE(numChannels, 22)
  buffer.writeUInt32LE(sampleRate, 24)
  buffer.writeUInt32LE(byteRate, 28)
  buffer.writeUInt16LE(blockAlign, 32)
  buffer.writeUInt16LE(bitsPerSample, 34)

  // data sub-chunk
  buffer.write('data', 36)
  buffer.writeUInt32LE(dataLength, 40)

  return buffer
}

async function main () {
  console.log(`Input file: ${inputPath}`)
  console.log(`Output file: ${outputPath}`)

  if (!fs.existsSync(inputPath)) {
    console.error('Error: Input file does not exist!')
    return
  }

  const decoder = new FFmpegDecoder({
    config: {
      audioFormat: 's16le', // Using f32le as it is standard for Whisper inference
      sampleRate: 16000
    }
  })

  try {
    console.log('Loading decoder...')
    await decoder.load()

    console.log('Starting decoding...')
    const audioStream = fs.createReadStream(inputPath)
    const response = await decoder.run(audioStream)

    const decodedFileBuffer = []
    let totalBytes = 0

    await response
      .onUpdate(output => {
        if (output && output.outputArray) {
          const bytes = new Uint8Array(output.outputArray)
          decodedFileBuffer.push(bytes)
          totalBytes += bytes.length
          process.stdout.write('.')
        }
      })
      .onFinish(() => {
        console.log('\nDecoding finished.')

        const wavHeader = writeWavHeader(16000, 1, 16, totalBytes)
        const finalBuffer = Buffer.concat([wavHeader, ...decodedFileBuffer])

        fs.writeFileSync(outputPath, finalBuffer)
        console.log(`\nSuccess! WAV audio saved to:\n${outputPath}`)
        console.log(`Total bytes: ${finalBuffer.length} (Header: 44 bytes, Data: ${totalBytes} bytes)`)
        console.log('Format: WAV (s16le, 16000Hz, Mono)')
      })
      .await()
  } catch (err) {
    console.error('Error during decoding:', err)
  } finally {
    await decoder.unload()
  }
}

main().catch(console.error)
