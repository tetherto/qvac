'use strict'

const { InferenceArgsSchema } = require('../validation')
const { spawn } = require('bare-subprocess')
const logger = require('../utils/logger')
const fs = require('bare-fs')
const process = require('bare-process')

const WHISPER_CPP_PATH = '/path/to/whisper.cpp/build/bin/whisper-cli'

const convertRawToWav = async (rawFilePath, wavFilePath) => {
  return new Promise((resolve, reject) => {
    const args = [
      '-f', 'f32le',
      '-ar', '16000',
      '-ac', '1',
      '-i', rawFilePath,
      wavFilePath
    ]

    const proc = spawn('ffmpeg', args, { stdio: 'inherit' })
    proc.on('exit', (code) => {
      if (code === 0) {
        resolve()
      } else {
        reject(new Error(`ffmpeg failed with code ${code}`))
      }
    })
    proc.on('error', reject)
  })
}

const runWhisperCppCli = async (audioFilePath, modelPath) => {
  const wavFilePath = audioFilePath.replace('.raw', '.wav')
  await convertRawToWav(audioFilePath, wavFilePath)

  return new Promise((resolve, reject) => {
    let stdout = ''
    let stderr = ''

    const args = [
      '-m', modelPath,
      '-f', wavFilePath,
      '--output-txt',
      '--no-timestamps'
    ]

    const proc = spawn(WHISPER_CPP_PATH, args, { stdio: 'pipe' })

    proc.stdout.on('data', (data) => {
      stdout += data.toString()
    })

    proc.stderr.on('data', (data) => {
      stderr += data.toString()
    })

    proc.on('exit', (code) => {
      fs.unlinkSync(wavFilePath)

      if (code === 0) {
        const lines = stdout.split('\n')
        const transcription = lines.find(line => line.trim() && !line.includes('[BLANK_AUDIO]'))?.trim() || ''
        resolve(transcription)
      } else {
        reject(new Error(`whisper.cpp failed with code ${code}: ${stderr}`))
      }
    })

    proc.on('error', (err) => {
      try { fs.unlinkSync(wavFilePath) } catch {}
      reject(err)
    })
  })
}

const runAddon = async (payload) => {
  const { inputs, config } = InferenceArgsSchema.parse(payload)

  logger.info(`Running whisper.cpp CLI with ${inputs.length} inputs`)

  const loadModelMs = 0
  const outputs = []
  const runStart = process.hrtime()

  for (const audioFilePath of inputs) {
    try {
      const transcription = await runWhisperCppCli(audioFilePath, config.path)
      outputs.push(transcription)
      logger.debug(`Transcribed: ${audioFilePath} -> ${transcription.substring(0, 50)}...`)
    } catch (error) {
      logger.error(`Error transcribing ${audioFilePath}:`, error)
      outputs.push('')
    }
  }

  const [runSec, runNano] = process.hrtime(runStart)
  const runMs = runSec * 1e3 + runNano / 1e6

  return {
    outputs,
    whisperVersion: 'whisper.cpp-cli',
    time: {
      loadModelMs,
      runMs
    }
  }
}

module.exports = {
  runAddon
}
