'use strict'

const { FFmpegDecoder } = require('@qvac/decoder-audio')
const fs = require('bare-fs')
const path = require('bare-path')

/**
 * Example demonstrating how to use FFmpegDecoder for audio processing and write output to a file
 */
async function main () {
  console.log('FFmpegDecoder Example')
  console.log('====================')

  // Create decoder instance with configuration
  const decoder = new FFmpegDecoder({
    config: {
      streamIndex: 0, // Audio stream index
      inputBitrate: 192000 // Input bitrate (192kbps)
    },
    logger: console
  })

  try {
    // Load the decoder
    console.log('\n1. Loading FFmpegDecoder...')
    await decoder.load()
    console.log('✓ Decoder loaded successfully')

    // Check decoder status
    console.log('\n2. Decoder status:', decoder.status())

    console.log('\n3. Processing audio file...')
    const audioFilePath = path.join(__dirname, 'samples/LastQuestion_long_EN.mp3')
    const outputFilePath = path.join(__dirname, 'samples/LastQuestion_long_EN.out.s16le')

    // Check if sample file exists
    if (await fs.exists(audioFilePath)) {
      const audioStream = fs.createReadStream(audioFilePath)
      const response = await decoder.run(audioStream)

      // Create a writable stream to save the decoded output
      const outputFileStream = fs.createWriteStream(outputFilePath)
      let writtenBytes = 0

      // Handle the response
      response.on('output', (data) => {
        // Write the decoded chunk (S16LE) to output file
        outputFileStream.write(Buffer.from(data.outputArray.buffer, data.outputArray.byteOffset, data.outputArray.byteLength))
        writtenBytes += data.outputArray.byteLength
        console.log(`Received decoded audio chunk: ${data.outputArray.length} bytes, total written: ${writtenBytes} bytes`)
      })

      response.on('end', () => {
        outputFileStream.end()
        console.log('✓ Audio processing completed')
        console.log(`✓ Written decoded audio to ${outputFilePath} (${writtenBytes} bytes)`)
      })

      response.on('error', (error) => {
        outputFileStream.destroy()
        console.error('✗ Audio processing failed:', error)
      })

      // Wait for processing to complete
      await new Promise((resolve, reject) => {
        response.on('end', resolve)
        response.on('error', reject)
      })
    } else {
      console.log('⚠ Sample audio file not found, skipping file processing example')
      console.log('   To test with a real file, place a LastQuestion_long_EN.mp3 in the examples directory')
    }
  } catch (error) {
    console.error('Example failed:', error)
  } finally {
    // Always unload the decoder
    console.log('\n4. Unloading decoder...')
    await decoder.unload()
    console.log('✓ Decoder unloaded successfully')
  }
}

// Run the example
if (require.main === module) {
  main().catch(console.error)
}

module.exports = main
