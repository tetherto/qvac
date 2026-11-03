'use strict'

function checkTurnOrdering(t, outputs) {
  let lastSegment = null
  let turnText = ''
  const completedTurns = []
  for (const output of outputs) {
    if (Array.isArray(output.tokenIds)) {
      lastSegment = output
      turnText += output.text
    } else if (output.type === 'endOfTurn') {
      t.ok(
        lastSegment && lastSegment.chunkIndex === output.chunkIndex,
        'the boundary follows its own transcript chunk'
      )
      t.ok(
        lastSegment && lastSegment.isEndOfTurn === true,
        'the boundary follows a marked EOU segment'
      )
      completedTurns.push(turnText)
      turnText = ''
    }
  }
  t.ok(
    completedTurns.every((text) => text.trim().length > 0),
    'submitting and clearing text on endOfTurn retains the complete turn'
  )
}

function checkStreamingMetadata(t, outputs) {
  const segments = outputs.filter((output) => Array.isArray(output.tokenIds))
  t.ok(segments.length > 0, 'native ASR segments include token IDs')
  t.ok(
    segments.every((segment) => segment.tokenIds.every(Number.isInteger)),
    'token IDs retain integer values'
  )
  t.ok(
    segments.every((segment) => typeof segment.isFinal === 'boolean'),
    'native segment finality is explicit'
  )
  t.ok(
    segments.some((segment) => segment.isFinal),
    'final native segments are delivered'
  )
  t.ok(
    segments.every((segment) => Number.isInteger(segment.chunkIndex)),
    'native chunk indices are preserved'
  )
  t.ok(
    segments.every((segment) => Number.isFinite(segment.eotConfidence)),
    'segment EOU confidence is preserved, including zero'
  )
  const events = outputs.filter((output) => output.type === 'endOfTurn')
  t.ok(events.length > 0, 'native EOU events are delivered')
  t.ok(
    events.every(
      (event) =>
        Number.isFinite(event.timestamp) &&
        Number.isInteger(event.chunkIndex) &&
        Number.isFinite(event.confidence)
    ),
    'EOU events retain native time, chunk index and confidence'
  )
  t.is(
    events.length,
    segments.filter((segment) => segment.isEndOfTurn).length,
    'EOU segment flags do not duplicate typed events'
  )
  checkTurnOrdering(t, outputs)
}

module.exports = { checkStreamingMetadata }
