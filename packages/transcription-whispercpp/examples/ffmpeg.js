// Decode and resample an audio file to F32 little-endian (called FLT in ffmpeg)
// 16KHz mono-channel output.
//
// Usage:
// bare main.js inputFile outputFile
//
// Example:
// bare main.js example.opus output.pcm
//
// Equivalent ffmpeg command:
// ffmpeg -y -i inputFile -f f32le -ar 16000 -ch_layout mono outputFile
//
// Play the decoded audio file:
// ffplay -f f32le -ar 16000 -ch_layout mono outputFile
const fs = require('bare-fs')
const ffmpeg = require('bare-ffmpeg')
const process = require('bare-process')

// F32LE uses 32 bits = 4 bytes.
const OUTPUT_FORMAT_BYTE_LENGTH = 2
const OUTPUT_FORMAT = ffmpeg.constants.sampleFormats.S16
const OUTPUT_SAMPLE_RATE = 16000
const OUTPUT_CHANNEL_LAYOUT = ffmpeg.constants.channelLayouts.MONO

// Overview:
// Frame - buffer for raw audio data (pure pulse-code modulated data).
// Packet - buffer for encoded audio data.
// Samples - buffer to access the data in frame.
//
// 1. Create an IO context with the audio buffer or options in case of streaming.
// 2. Pass it to `InputFormatContext`.
// 3. Choose the stream for decoding.
// 4. Create its decoder as `stream.decoder()`.
// 5. Create resampler with the from properties and to properties.
// 6. Read packets from format.
// 7. Use `packet.streamIndex` to send it to corresponding decoder.
// 8. Receive the frame from decoder.
// 9. Create the output frame to store data we expect out of resampler and set its properties.
// 10. Pass both input frame and output frame to resampler.
// 11. Receive frame from resampler.
// 12. Get the data stored in the frame by using `Samples`.
// 13. Repeat till out input has packets.
// 14. Get the remaining data out of resampler.
// 15. By concatenating all the output data, we get decoded audio.
function decodeAudio (audio) {
  const io = new ffmpeg.IOContext(audio)
  const format = new ffmpeg.InputFormatContext(io)

  let result

  // If the file has multiple streams (like different language tracks), then we
  // should let the user choose which stream they want. If the file can be a
  // video, then please check that the stream is an audio track before
  // processing.
  for (const stream of format.streams) {
    console.log(stream.codec, stream.codecParameters)
    const packet = new ffmpeg.Packet()
    const raw = new ffmpeg.Frame()

    const resampler = new ffmpeg.Resampler(
      stream.codecParameters.sampleRate,
      stream.codecParameters.channelLayout,
      stream.codecParameters.format,
      OUTPUT_SAMPLE_RATE,
      OUTPUT_CHANNEL_LAYOUT,
      OUTPUT_FORMAT
    )

    const decoder = stream.decoder()
    const buffers = []

    while (format.readFrame(packet)) {
      decoder.sendPacket(packet)

      while (decoder.receiveFrame(raw)) {
        const output = new ffmpeg.Frame()
        output.channelLayout = OUTPUT_CHANNEL_LAYOUT
        output.format = OUTPUT_FORMAT
        output.sampleRate = OUTPUT_SAMPLE_RATE
        output.nbSamples = raw.nbSamples

        const samples = new ffmpeg.Samples(
          output.format,
          output.channelLayout.nbChannels,
          output.nbSamples
        )
        samples.fill(output)

        // samples.data.length is always fixed, like 8192 bytes. So we need to
        // extract only the data we need through `subarray`. `resampler.convert`
        // gives the number of samples converted per channel. So
        // `bytesPerSample` * `samplesPerChannel` * `channelsPerSample` gives
        // total amount of bytes.
        const count = resampler.convert(raw, output)
        const length =
          OUTPUT_FORMAT_BYTE_LENGTH * count * output.channelLayout.nbChannels
        const buf = Buffer.from(samples.data.subarray(0, length))
        buffers.push(buf)
      }

      packet.unref()
    }

    const output = new ffmpeg.Frame()
    output.channelLayout = OUTPUT_CHANNEL_LAYOUT
    output.format = OUTPUT_FORMAT
    output.sampleRate = OUTPUT_SAMPLE_RATE
    output.nbSamples = 1024

    const samples = new ffmpeg.Samples(
      output.format,
      output.channelLayout.nbChannels,
      output.nbSamples
    )
    samples.fill(output)

    while (resampler.flush(output) > 0) {
      buffers.push(Buffer.from(samples.data))
    }

    result = Buffer.concat(buffers)
  }

  return result
}

const inputFile = process.argv[2]
const outputFile = process.argv[3]

const result = decodeAudio(fs.readFileSync(inputFile))
fs.writeFileSync(outputFile, result)
