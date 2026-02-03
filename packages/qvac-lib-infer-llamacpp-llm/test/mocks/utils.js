'use strict'

const transitionCb = (instance, newState) => {
  console.log(`State transitioned to: ${newState}`)
}

// A helper function to wait a short time (to allow setImmediate callbacks to fire)
const wait = (ms = 20) => new Promise(resolve => setTimeout(resolve, ms))

// Factory to create a shared onOutput handler and expose collected state
function makeOutputCollector (t, logger = console) {
  const outputText = {}
  let jobCompleted = false
  let generatedText = ''

  function onOutput (addon, event, jobId, output, error) {
    if (event === 'Output') {
      if (!outputText[jobId]) outputText[jobId] = ''
      outputText[jobId] += output
      generatedText += output
    } else if (event === 'Error') {
      t.fail(`Job ${jobId} error: ${error}`)
    } else if (event === 'JobEnded') {
      logger.log(`Job ${jobId} completed. Output: "${outputText[jobId]}"`)
      jobCompleted = true
    }
  }

  return {
    onOutput,
    outputText,
    get generatedText () { return generatedText },
    get jobCompleted () { return jobCompleted }
  }
}

module.exports = {
  transitionCb,
  wait,
  makeOutputCollector
}
