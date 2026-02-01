'use strict'

const { InferenceArgsSchema } = require('../validation')
const { getInferenceManager } = require('./inferenceManager')
const { spawn } = require('bare-subprocess')
const logger = require('../utils/logger')
const fs = require('bare-fs')
const { Readable } = require('bare-stream')

const loadedModels = new Map()

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
  } catch {
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
 * Runs an addon with the given payload.
 * @param {object} payload - The payload to run the addon with
 * @returns {Promise<{outputs: string[], whisperVersion: string, vadVersion: string, time: {loadModelMs: number, runMs: number}}}> The result of the addon run
 */
const runAddon = async (payload) => {
  const { inputs, whisper, link, params, opts, config, vad } =
    InferenceArgsSchema.parse(payload)

  const { lib: whisperLib, version: whisperVerReq } = whisper
  const { enabled: vadEnabled, lib: vadLib, version: vadVerReq } = vad

  const whisperVersion = await ensurePackage(whisperLib, whisperVerReq)
  const whisperPlugin = require(whisperLib)

  let vadVersion, vadInstance
  if (vadEnabled) {
    vadVersion = await ensurePackage(vadLib, vadVerReq)
    if (!loadedModels.has(vadLib)) {
      const VadClass = require(vadLib)
      vadInstance = new VadClass()
      await vadInstance.load()
      loadedModels.set(vadLib, vadInstance)
      logger.info(`Loaded new VAD addon for ${vadLib}@${vadVersion}`)
    } else {
      vadInstance = loadedModels.get(vadLib)
    }
  }

  const inferenceManager = getInferenceManager()
  logger.info(`Running addon with ${inputs.length} inputs`)

  // -----------------------------
  // Benchmark loadModel
  // -----------------------------
  let modelRef = loadedModels.get(whisperLib)
  let loadModelMs = 0

  if (!modelRef) {
    const loadStart = process.hrtime()
    modelRef = await inferenceManager.loadModel({
      plugin: whisperPlugin,
      link,
      params,
      opts,
      config
    })
    const [loadSec, loadNano] = process.hrtime(loadStart)
    loadModelMs = loadSec * 1e3 + loadNano / 1e6
    loadedModels.set(whisperLib, modelRef)
    logger.info(`Loaded new model for ${whisperLib}`)
  }
  const model = inferenceManager.getModel({ id: modelRef.id })

  // -----------------------------
  // Benchmark run
  // -----------------------------
  const outputs = []
  const runStart = process.hrtime()
  for (const audioFilePath of inputs) {
    const audioStream = fs.createReadStream(audioFilePath, {
      highWaterMark: config?.sampleRate ?? 16000
    })

    let inputStream = audioStream
    if (vadEnabled) {
      const vadStream = new Readable({ read () { } })
      const segments = await vadInstance.run(audioStream)
      segments
        .onUpdate(({ tsArrayBuffer }) => vadStream.push(new Uint8Array(tsArrayBuffer)))
        .onFinish(() => vadStream.push(null))
      inputStream = vadStream
    }

    const output = []
    const response = await model.run(inputStream)
    await response.onUpdate(outputArr => {
      for (const data of outputArr) {
        if (data.text) {
          output.push(data.text)
        }
      }
    }).await()
    outputs.push(output.join(''))
  }
  const [runSec, runNano] = process.hrtime(runStart)
  const runMs = runSec * 1e3 + runNano / 1e6

  return {
    outputs,
    whisperVersion,
    vadVersion: vadEnabled ? vadVersion : undefined,
    time: {
      loadModelMs,
      runMs
    }
  }
}

module.exports = {
  runAddon
}
