'use strict'

const QvacResponse = require('@qvac/response')
const QvacLogger = require('@qvac/logging')
const ffmpeg = require('bare-ffmpeg')
const BaseInference = require('@qvac/infer-base/WeightsProvider/BaseInference')
const { QvacErrorDecoderAudio, ERR_CODES } = require('./utils/error')

/**
 * FFmpeg-based audio decoder (single-threaded)
 */
class FFmpegDecoder extends BaseInference {
  SUPPORTED_AUDIO_FORMATS = {
    s16le: {
      format: null, // Will be set to ffmpeg.constants.sampleFormats.S16
      byteLength: 2
    },
    f32le: {
      format: null, // Will be set to ffmpeg.constants.sampleFormats.FLT
      byteLength: 4
    }
  }

  OUTPUT_CHANNEL_LAYOUT = null // Will be set to ffmpeg.constants.channelLayouts.MONO
  /**
   * Creates an instance of FFmpegDecoder.
   * @param {Object} config - Configuration options
   * @param logger - Logger instance
   * @param streamIndex - Index of the stream to decode. Default: 0
   * @param inputBitrate - Input audio bitrate. Default: 192000
   * @param audioFormat - Output audio format. Default: 's16le'
   * @param args - Additional arguments passed to BaseInference
   * @param {Object} [config.streamIndex] - Index of the stream to decode (default: 0)
   * @param {number} [config.inputBitrate] - Input audio bitrate (default: 192000)
   * @param {string} [config.audioFormat] - Output audio format (default: 'f32le')
   * @param {number} [config.sampleRate] - Output sample rate (default: 16000)
   * @param {Object} [config.logger] - Logger instance
   */
  constructor ({
    config = {},
    logger = null,
    streamIndex = 0,
    inputBitrate = 192000,
    audioFormat = 's16le',
    ...args
  }) {
    super({ ...args, logger })

    this.config = {
      streamIndex: config.streamIndex || streamIndex,
      inputBitrate: config.inputBitrate || inputBitrate,
      audioFormat: config.audioFormat || audioFormat,
      sampleRate: config.sampleRate || 16000
    }

    this.logger = new QvacLogger(logger)
    this.isLoaded = false
    this.currentJob = null

    // Encoder delay handling
    this.samplesSkipped = 0
    this.totalSkipSamples = 0

    // Runtime stats
    this._resetStats()
  }

  /**
   * Resets the runtime stats
   */
  _resetStats () {
    this._runtimeStats = {
      decodeTimeMs: 0,
      inputBytes: 0,
      outputBytes: 0,
      samplesDecoded: 0,
      codecName: null,
      inputSampleRate: 0,
      outputSampleRate: this.config.sampleRate,
      audioFormat: this.config.audioFormat
    }
  }

  /**
   * Get the current runtime stats
   * @returns {Object} Current runtime stats
   */
  runtimeStats () {
    return { ...this._runtimeStats }
  }

  /**
   * Load and initialize the decoder
   */
  async load () {
    if (this.isLoaded) {
      this.logger.info('FFmpegDecoder already loaded')
      return
    }

    this.logger.info('Loading FFmpegDecoder with config:', this.config)

    // Initialize format constants
    this.SUPPORTED_AUDIO_FORMATS.s16le.format = ffmpeg.constants.sampleFormats.S16
    this.SUPPORTED_AUDIO_FORMATS.f32le.format = ffmpeg.constants.sampleFormats.FLT
    this.OUTPUT_CHANNEL_LAYOUT = ffmpeg.constants.channelLayouts.MONO

    // Validate audio format
    if (!this.SUPPORTED_AUDIO_FORMATS[this.config.audioFormat]) {
      throw new QvacErrorDecoderAudio({
        code: ERR_CODES.UNSUPPORTED_AUDIO_FORMAT,
        adds: this.config.audioFormat
      })
    }

    this.isLoaded = true
    this.logger.info('FFmpegDecoder loaded successfully')
  }

  /**
   * Unload the decoder and clean up resources
   */
  async unload () {
    if (!this.isLoaded) {
      return
    }

    this.logger.info('Unloading FFmpegDecoder')

    this.isLoaded = false
    this.currentJob = null
    this.logger.info('FFmpegDecoder unloaded')
  }

  /**
   * Run the decoder on an audio stream
   * @param {Readable} audioStream - Input audio stream
   * @returns {QvacResponse} Response with decoded audio
   */
  async run (audioStream) {
    if (!this.isLoaded) {
      throw new QvacErrorDecoderAudio({ code: ERR_CODES.DECODER_NOT_LOADED })
    }

    this.logger.info('Starting new audio stream processing')

    const response = new QvacResponse({
      cancelHandler: () => this.stop(),
      pauseHandler: () => this.pause(),
      continueHandler: () => this.unpause()
    })

    this.currentJob = {
      response,
      audioChunks: [],
      isActive: true,
      isPaused: false
    }

    // Process the audio stream
    this._processStream(audioStream).catch(err => {
      this.logger.error('Error processing audio stream:', err)
      response.failed(err)
    })

    return response
  }

  _getBufferSize (inputBitrate) {
    const maxBufferSize = 1024 * 1024 // 1MB max
    return Math.min((inputBitrate / 8) * 4, maxBufferSize)
  }

  _processFrame (decoder, raw, resampler, job) {
    const OUTPUT_FORMAT = this.SUPPORTED_AUDIO_FORMATS[this.config.audioFormat].format
    const OUTPUT_FORMAT_BYTE_LENGTH = this.SUPPORTED_AUDIO_FORMATS[this.config.audioFormat].byteLength
    const OUTPUT_SAMPLE_RATE = this.config.sampleRate

    while (decoder.receiveFrame(raw)) {
      const output = new ffmpeg.Frame()
      output.channelLayout = this.OUTPUT_CHANNEL_LAYOUT
      output.format = OUTPUT_FORMAT
      output.sampleRate = OUTPUT_SAMPLE_RATE
      output.nbSamples = raw.nbSamples

      const samples = new ffmpeg.Samples(
        output.format,
        output.channelLayout.nbChannels,
        output.nbSamples
      )
      samples.fill(output)

      const count = resampler.convert(raw, output)

      // Handle encoder delay by skipping initial samples
      if (this.samplesSkipped < this.totalSkipSamples) {
        const samplesToSkip = Math.min(count, this.totalSkipSamples - this.samplesSkipped)
        this.samplesSkipped += samplesToSkip
        if (samplesToSkip >= count) continue // Skip entire frame

        // Skip partial frame
        const skipBytes = OUTPUT_FORMAT_BYTE_LENGTH * samplesToSkip * output.channelLayout.nbChannels
        const length = OUTPUT_FORMAT_BYTE_LENGTH * (count - samplesToSkip) * output.channelLayout.nbChannels
        const chunk = Buffer.from(samples.data.subarray(skipBytes, skipBytes + length))
        job.response.updateOutput({ outputArray: chunk })

        // Track stats for partial frame
        this._runtimeStats.samplesDecoded += (count - samplesToSkip)
        this._runtimeStats.outputBytes += length
      } else {
        const length = OUTPUT_FORMAT_BYTE_LENGTH * count * output.channelLayout.nbChannels
        const chunk = Buffer.from(samples.data.subarray(0, length))
        job.response.updateOutput({ outputArray: chunk })

        // Track stats
        this._runtimeStats.samplesDecoded += count
        this._runtimeStats.outputBytes += length
      }
    }
  }

  _processPacket (format, packet, raw, decoder, resampler, job) {
    while (format.readFrame(packet)) {
      decoder.sendPacket(packet)
      this._processFrame(decoder, raw, resampler, job)
      packet.unref()
    }
  }

  _processFFmpegStream (format, stream, job) {
    const OUTPUT_FORMAT = this.SUPPORTED_AUDIO_FORMATS[this.config.audioFormat].format
    const OUTPUT_FORMAT_BYTE_LENGTH = this.SUPPORTED_AUDIO_FORMATS[this.config.audioFormat].byteLength
    const OUTPUT_SAMPLE_RATE = this.config.sampleRate

    this.logger.debug('[FFmpegDecoder] Stream codec:', stream.codec, stream.codecParameters)

    // Track codec info in stats
    this._runtimeStats.codecName = stream.codec.name
    this._runtimeStats.inputSampleRate = stream.codecParameters.sampleRate

    const packet = new ffmpeg.Packet()
    const raw = new ffmpeg.Frame()

    const resampler = new ffmpeg.Resampler(
      stream.codecParameters.sampleRate,
      stream.codecParameters.channelLayout,
      stream.codecParameters.format,
      OUTPUT_SAMPLE_RATE,
      this.OUTPUT_CHANNEL_LAYOUT,
      OUTPUT_FORMAT
    )

    const decoder = stream.decoder()
    decoder.open()

    // Auto-detect encoder delay: lossy codecs need ~400ms skipped to remove artifacts
    const codecName = stream.codec.name.toLowerCase()
    const SKIP_MS = {
      mp3: 400,
      vorbis: 400,
      opus: 150,
      aac: 300
    }

    const skipMs = SKIP_MS[codecName] || 0
    this.samplesSkipped = 0
    this.totalSkipSamples = Math.floor((OUTPUT_SAMPLE_RATE * skipMs) / 1000)

    if (this.totalSkipSamples > 0) {
      this.logger.info(`[FFmpegDecoder] Skipping ${skipMs}ms (${this.totalSkipSamples} samples) for ${codecName} to remove encoder artifacts`)
    }

    this._processPacket(format, packet, raw, decoder, resampler, job)

    // Flush resampler
    const output = new ffmpeg.Frame()
    output.channelLayout = this.OUTPUT_CHANNEL_LAYOUT
    output.format = OUTPUT_FORMAT
    output.sampleRate = OUTPUT_SAMPLE_RATE
    output.nbSamples = 1024

    const samples = new ffmpeg.Samples(
      output.format,
      output.channelLayout.nbChannels,
      output.nbSamples
    )
    samples.fill(output)

    let flushCount
    while ((flushCount = resampler.flush(output)) > 0) {
      const actualLength = OUTPUT_FORMAT_BYTE_LENGTH * flushCount * output.channelLayout.nbChannels
      const chunk = Buffer.from(samples.data.subarray(0, actualLength))
      job.response.updateOutput({ outputArray: chunk })

      // Track stats for flushed samples
      this._runtimeStats.samplesDecoded += flushCount
      this._runtimeStats.outputBytes += actualLength
    }

    decoder.destroy()
  }

  async _collectStreamData (audioStream, job) {
    const chunks = []
    let totalBytes = 0

    for await (const chunk of audioStream) {
      if (!job.isActive) {
        this.logger.info('[FFmpegDecoder] Job cancelled, stopping stream collection')
        break
      }

      while (job.isPaused) {
        this.logger.debug('[FFmpegDecoder] Job is paused, waiting to resume...')
        await new Promise(resolve => setTimeout(resolve, 100))
      }

      chunks.push(chunk)
      totalBytes += chunk.length
      this.logger.debug(`[FFmpegDecoder] Collected chunk, total bytes: ${totalBytes}`)
    }

    return Buffer.concat(chunks)
  }

  async _processStream (audioStream) {
    const job = this.currentJob
    if (!job.isActive) {
      return
    }

    // Reset and start tracking stats
    this._resetStats()
    const startTime = Date.now()

    try {
      this.logger.info('[FFmpegDecoder] Starting stream processing')

      // Collect all audio data from stream
      const audioBuffer = await this._collectStreamData(audioStream, job)
      this.logger.info(`[FFmpegDecoder] Collected ${audioBuffer.length} bytes of audio data`)

      // Track input bytes
      this._runtimeStats.inputBytes = audioBuffer.length

      if (!job.isActive) {
        this.logger.info('[FFmpegDecoder] Job cancelled after data collection')
        return
      }

      // Create FFmpeg IO context with the buffer
      const bufferSize = this._getBufferSize(this.config.inputBitrate)
      let bufferOffset = 0

      const io = new ffmpeg.IOContext(bufferSize, {
        onread: (buffer, requestedLen) => {
          const remainingBytes = audioBuffer.length - bufferOffset
          const bytesToRead = Math.min(requestedLen, remainingBytes)

          if (bytesToRead <= 0) {
            return 0 // EOF
          }

          audioBuffer.copy(buffer, 0, bufferOffset, bufferOffset + bytesToRead)
          bufferOffset += bytesToRead

          this.logger.debug(`[FFmpegDecoder] Read ${bytesToRead} bytes from buffer, offset now: ${bufferOffset}`)
          return bytesToRead
        },
        onseek: (offset, whence) => {
          const AVSEEK_SIZE = 0x10000

          if (whence === AVSEEK_SIZE) {
            return audioBuffer.length
          }

          let newOffset
          if (whence === 0) {
            newOffset = offset
          } else if (whence === 1) {
            newOffset = bufferOffset + offset
          } else if (whence === 2) {
            newOffset = audioBuffer.length + offset
          } else {
            return -1
          }

          if (newOffset < 0 || newOffset > audioBuffer.length) {
            return -1
          }

          bufferOffset = newOffset
          this.logger.debug(`[FFmpegDecoder] Seek to offset: ${bufferOffset}`)
          return bufferOffset
        }
      })

      this.logger.debug('[FFmpegDecoder] IOContext created')
      const format = new ffmpeg.InputFormatContext(io)
      this.logger.debug('[FFmpegDecoder] InputFormatContext created')

      const streamIndex = this.config.streamIndex || 0
      if (format.streams[streamIndex] === undefined) {
        throw new QvacErrorDecoderAudio({
          code: ERR_CODES.STREAM_INDEX_OUT_OF_BOUNDS,
          adds: streamIndex
        })
      }

      // Process the stream and generate decoded output
      this._processFFmpegStream(format, format.streams[streamIndex], job)

      // Calculate final decode time
      this._runtimeStats.decodeTimeMs = Date.now() - startTime

      // Update stats on response before ending
      job.response.updateStats(this.runtimeStats())

      // Mark as complete
      job.response.ended()
      this.logger.info('[FFmpegDecoder] Stream processing completed successfully')
      this.logger.info(`[FFmpegDecoder] Runtime stats: ${JSON.stringify(this._runtimeStats)}`)
    } catch (err) {
      // Still capture stats even on error
      this._runtimeStats.decodeTimeMs = Date.now() - startTime
      job.response.updateStats(this.runtimeStats())

      this.logger.error('Error processing audio stream:', err)
      job.response.failed(err)
    }

    this.logger.info('Audio _processStream completed')
  }

  /**
   * Pause the current job
   */
  pause () {
    if (this.currentJob) {
      this.currentJob.isPaused = true
      this.logger.debug('Decoder paused')
    }
    return Promise.resolve()
  }

  /**
   * Unpause the current job
   */
  unpause () {
    if (this.currentJob) {
      this.currentJob.isPaused = false
      this.logger.debug('Decoder unpaused')
    }
    return Promise.resolve()
  }

  /**
   * Stop the current job
   */
  stop () {
    if (this.currentJob) {
      this.currentJob.isActive = false
      this.currentJob.response.finish()
      this.logger.debug('Decoder stopped')
    }
    return Promise.resolve()
  }

  /**
   * Get the current status
   */
  status () {
    return {
      loaded: this.isLoaded,
      active: this.currentJob?.isActive || false,
      paused: this.currentJob?.isPaused || false
    }
  }
}

module.exports = { FFmpegDecoder }
