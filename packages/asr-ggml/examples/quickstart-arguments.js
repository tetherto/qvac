'use strict'

const MAX_ARGUMENTS = 3
const USAGE = 'Usage: bare examples/quickstart.js [audioPath] [modelPath] [vadModelPath]'

function parseQuickstartArguments(argv) {
  if (argv.length > MAX_ARGUMENTS) {
    throw new Error(USAGE)
  }

  const [audioPath, modelPath, vadModelPath] = argv
  return { audioPath, modelPath, vadModelPath }
}

module.exports = { parseQuickstartArguments, USAGE }
