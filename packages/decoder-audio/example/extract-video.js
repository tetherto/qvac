'use strict'

const fs = require('bare-fs')
const process = require('bare-process')
const { VideoFrameDecoder } = require('..')

async function main() {
  const filename = process.argv[2]
  if (!filename) throw new Error('Usage: bare example/extract-video.js <video.mp4> [--chunks]')
  const input = process.argv.includes('--chunks') ? fs.createReadStream(filename) : filename
  const decoder = new VideoFrameDecoder()
  for await (const frame of decoder.frames(input)) {
    console.log({ ptsMs: frame.ptsMs, width: frame.width, height: frame.height, bytes: frame.rgb.byteLength })
  }
  console.log(decoder.runtimeStats)
}

main().catch((error) => {
  console.error(error)
  process.exitCode = 1
})
