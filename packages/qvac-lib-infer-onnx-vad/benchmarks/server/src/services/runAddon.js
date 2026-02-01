'use strict'

const { InferenceArgsSchema } = require('../validation')
const { spawn } = require('bare-subprocess')
const logger = require('../utils/logger')
const fs = require('bare-fs')
const path = require('bare-path')
const os = require('bare-os')

/**
 * Get package version from package.json
 * @param {string} lib - Package name
 * @returns {string|null} Package version or null if not found
 */
const getPackageVersion = (lib) => {
  try {
    const packagePath = require.resolve(`${lib}/package`)
    const pkg = require(packagePath)
    return pkg.version
  } catch (error) {
    return null
  }
}

/**
 * Ensure that `lib@version` is installed.
 * @param {string} lib - Package name
 * @param {string} requestedVersion - Requested version
 * @returns {Promise<string>} Installed version
 */
const ensurePackage = async (lib, requestedVersion) => {
  const installed = getPackageVersion(lib)
  if (installed && (!requestedVersion || installed === requestedVersion)) {
    return installed
  }
  const versionSpec = requestedVersion ? `@${requestedVersion}` : ''
  logger.info(`Installing ${lib}${versionSpec}...`)
  await new Promise((resolve, reject) => {
    const npm = spawn('npm', ['install', `${lib}${versionSpec}`], { stdio: 'inherit' })
    npm
      .on('exit', code => code === 0 ? resolve() : reject(new Error(`npm install ${lib}${versionSpec} failed (${code})`)))
      .on('error', reject)
  })
  const newVersion = getPackageVersion(lib)
  if (!newVersion) {
    throw new Error(`Failed to verify installation of ${lib}${versionSpec}`)
  }
  return newVersion
}

/**
 * Ensure directory exists
 * @param {string} dirPath - Directory path to create
 */
const ensureDirectoryExists = (dirPath) => {
  try {
    if (!fs.existsSync(dirPath)) {
      fs.mkdirSync(dirPath, { recursive: true })
      logger.info(`Created directory: ${dirPath}`)
    }
  } catch (error) {
    logger.error(`Failed to create directory ${dirPath}:`, error.message)
    throw error
  }
}

/**
 * Runs an addon with the given payload.
 * @param {Object} payload - The payload containing the input, library, params, opts, config
 * @returns {Promise<{ outputs: any[]; version: string; time: { loadModelMs: number; runMs: number }; outputFiles: string[] }>} - A promise that resolves to the output, version, timings, and output files.
 */
const runAddon = async (payload) => {
  const { inputs, lib, version: requestedVersion, params, opts, config } = InferenceArgsSchema.parse(payload)

  const version = await ensurePackage(lib, requestedVersion)

  const ONNXSileroVad = require(lib)
  const model = new ONNXSileroVad({
    params,
    opts
  })
  logger.info(`Running addon with ${inputs.length} inputs`)

  // Create temp directory for this session
  const outputDir = path.join(os.tmpdir(), 'vad_output')
  ensureDirectoryExists(outputDir)
  logger.info(`Using temp directory: ${outputDir}`)

  // -----------------------------
  // Benchmark loadModel
  // -----------------------------
  const loadStart = process.hrtime()
  await model.load()
  const [loadSec, loadNano] = process.hrtime(loadStart)
  const loadModelMs = loadSec * 1e3 + loadNano / 1e6
  logger.info(`Loaded new model for ${lib}`)

  // -----------------------------
  // Benchmark run
  // -----------------------------
  const outputFiles = []
  const runStart = process.hrtime()

  for (let i = 0; i < inputs.length; i++) {
    const audioFilePath = inputs[i]

    // Verify input file exists
    if (!fs.existsSync(audioFilePath)) {
      logger.error(`Input file does not exist: ${audioFilePath}`)
      continue
    }

    const audioStream = fs.createReadStream(audioFilePath, {
      highWaterMark: config?.sampleRate ?? 32.5
    })

    // Create unique output filename for each input
    const inputFileName = path.basename(audioFilePath, path.extname(audioFilePath))
    const timestamp = Date.now()
    const outputFilePath = path.join(outputDir, `${inputFileName}_${timestamp}_${i}.flac`)

    // Remove existing output file if it exists
    if (fs.existsSync(outputFilePath)) {
      try {
        fs.unlinkSync(outputFilePath)
        logger.info(`Removed existing file: ${outputFilePath}`)
      } catch (error) {
        logger.warn(`Failed to remove existing file ${outputFilePath}:`, error.message)
      }
    }

    logger.info(`Processing: ${audioFilePath} -> ${outputFilePath}`)

    try {
      const response = await model.run(audioStream)

      await response.onUpdate(outputArr => {
        try {
          const audioData = new Float32Array(outputArr.tsArrayBuffer)

          // VAD parameters from the C++ code
          const sampleRate = 16000 // 16kHz
          const vadFrameRate = 32.0 // 32 Hz = 31.25ms frames
          const samplesPerFrame = sampleRate / vadFrameRate // 500 samples per frame

          // Calculate number of frames using ceil (same as reference)
          const audioLengthSeconds = audioData.length / sampleRate
          const numFrames = Math.ceil(audioLengthSeconds * vadFrameRate)
          const flags = new Uint8Array(numFrames)

          // Check each 31.25ms frame for speech activity
          for (let frameIdx = 0; frameIdx < numFrames; frameIdx++) {
            const startSample = Math.floor(frameIdx * samplesPerFrame)
            const endSample = Math.floor((frameIdx + 1) * samplesPerFrame)

            // Check if any sample in this frame is non-zero (speech detected)
            let hasSpeech = false
            for (let i = startSample; i < endSample && i < audioData.length; i++) {
              if (Math.abs(audioData[i]) > 1e-6) {
                hasSpeech = true
                break
              }
            }

            flags[frameIdx] = hasSpeech ? 1 : 0
          }

          fs.appendFileSync(outputFilePath, Buffer.from(flags))
        } catch (writeError) {
          logger.error(`Error writing to ${outputFilePath}:`, writeError.message)
        }
      }).await()

      // Verify file was created and get size
      if (fs.existsSync(outputFilePath)) {
        const stats = fs.statSync(outputFilePath)
        logger.info(`Completed: ${outputFilePath} (${stats.size} bytes)`)
        outputFiles.push(outputFilePath)
      } else {
        logger.warn(`Output file was not created: ${outputFilePath}`)
      }
    } catch (processError) {
      logger.error(`Error processing ${audioFilePath}:`, processError.message)
    }
  }

  const [runSec, runNano] = process.hrtime(runStart)
  const runMs = runSec * 1e3 + runNano / 1e6

  logger.info(`Processed ${inputs.length} files in ${runMs.toFixed(2)}ms`)
  logger.info(`Created ${outputFiles.length} output files in ${outputDir}`)

  return {
    outputFiles,
    tempDirectory: outputDir,
    version,
    time: {
      loadModelMs,
      runMs
    }
  }
}

module.exports = {
  runAddon
}
