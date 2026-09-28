'use strict'

const fs = require('bare-fs')
const process = require('bare-process')
const { FFmpegDecoder } = require('..')

async function main() {
  const inputPath = process.argv[2] || './example/sample.mp3'
  const outputPath = process.argv[3] || './example/output_stream.raw'
  const decoder = new FFmpegDecoder()
  await decoder.load()
  const output = fs.openSync(outputPath, 'w')

  try {
    const response = decoder.run(fs.createReadStream(inputPath), { retainOutput: false })
    for await (const { outputArray } of response.iterate()) {
      fs.writeSync(output, outputArray)
    }
    console.log(`Decoded PCM saved to ${outputPath}`)
  } finally {
    fs.closeSync(output)
    await decoder.unload()
  }
}

main().catch((error) => {
  console.error(error)
  process.exitCode = 1
})
