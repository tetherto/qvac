'use strict'

const path = require('path')
const { FormatError, withFileCursor } = require('./file-cursor')
const { describeWhisperModel, describeWhisperVad } = require('./whisper')
const { describeBciEmbedder } = require('./bci-embedder')
const { describeIndicTrans } = require('./nmt')
const { describeMarianModel, describeMarianShortlist } = require('./marian')
const { describeSentencePiece } = require('./sentencepiece')

const WHISPER_ENGINE = '@qvac/transcription-whispercpp'
const BCI_ENGINE = '@qvac/bci-whispercpp'
const NMT_ENGINE = '@qvac/translation-nmtcpp'

const DESCRIBERS_BY_EXTENSION = {
  '.bin': {
    [WHISPER_ENGINE]: [describeWhisperModel, describeWhisperVad],
    [BCI_ENGINE]: [describeWhisperModel, describeBciEmbedder],
    [NMT_ENGINE]: [describeIndicTrans, describeMarianModel, describeMarianShortlist]
  },
  '.spm': {
    [NMT_ENGINE]: [describeSentencePiece]
  }
}

function describersFor(filePath, engine) {
  const byEngine = DESCRIBERS_BY_EXTENSION[path.extname(filePath).toLowerCase()]
  return (byEngine && byEngine[engine]) || []
}

function supportsWeightlessDescription(filePath, engine) {
  return describersFor(filePath, engine).length > 0
}

async function attempt(cursor, describe) {
  cursor.rewind()
  try {
    return { description: await describe(cursor) }
  } catch (err) {
    if (err instanceof FormatError) return { reason: `${describe.name}: ${err.message}` }
    throw err
  }
}

async function firstDescription(cursor, describers) {
  const reasons = []
  for (const describe of describers) {
    const outcome = await attempt(cursor, describe)
    if (outcome.description) return outcome.description
    reasons.push(outcome.reason)
  }
  throw new FormatError(`no weightless description fits the file (${reasons.join('; ')})`)
}

function describeArtifact(filePath, engine) {
  const describers = describersFor(filePath, engine)
  return withFileCursor(filePath, (cursor) => firstDescription(cursor, describers))
}

module.exports = { supportsWeightlessDescription, describeArtifact }
