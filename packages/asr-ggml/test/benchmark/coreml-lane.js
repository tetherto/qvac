'use strict'

const COREML_BACKEND = 'coreml'

function countCoremlRuns(runs) {
  return runs.filter((run) => run.encoderUsedCoreml === 1).length
}

function describeCoremlRuns(coremlRuns, totalRuns) {
  return `${coremlRuns} of ${totalRuns} measured runs reported encoderUsedCoreml`
}

function checkCoremlLane({ runs, expectCoreml }) {
  const coremlRuns = countCoremlRuns(runs)
  const allRunsOnCoreml = runs.length > 0 && coremlRuns === runs.length

  if (expectCoreml && !allRunsOnCoreml) {
    return {
      allRunsOnCoreml,
      failure:
        `Core ML lane requested but ${describeCoremlRuns(coremlRuns, runs.length)}; ` +
        'refusing to write a coreml-labelled artifact (the sidecar did not load, ' +
        'or a run fell back to ggml)'
    }
  }

  if (!expectCoreml && coremlRuns > 0) {
    return {
      allRunsOnCoreml,
      failure:
        `encoder ran on Core ML in a non-Core ML lane (${describeCoremlRuns(coremlRuns, runs.length)}); ` +
        'a sidecar is visible to this lane and its numbers would be mislabelled'
    }
  }

  return { allRunsOnCoreml, failure: null }
}

function resolveActiveBackend({ allRunsOnCoreml, backendName }) {
  return allRunsOnCoreml ? COREML_BACKEND : backendName
}

module.exports = { checkCoremlLane, resolveActiveBackend, COREML_BACKEND }
