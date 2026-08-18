'use strict'

function parseCloneArgs(args) {
  let useGPU = false
  let refAudio
  let promptText
  const positional = []

  const takeValue = (flag, value) => {
    if (value === undefined || value.startsWith('--')) {
      throw new Error(`${flag} needs a value`)
    }
    return value
  }

  for (let i = 0; i < args.length; i++) {
    const arg = args[i]
    if (arg === '--gpu') {
      useGPU = true
    } else if (arg === '--reference-audio') {
      refAudio = takeValue(arg, args[i + 1])
      i++
    } else if (arg === '--prompt-text') {
      promptText = takeValue(arg, args[i + 1])
      i++
    } else {
      positional.push(arg)
    }
  }
  return { useGPU, refAudio, promptText, positional }
}

module.exports = { parseCloneArgs }
