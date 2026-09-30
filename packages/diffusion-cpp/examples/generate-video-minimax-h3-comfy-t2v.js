'use strict'

const process = require('bare-process')
const { runH3Video } = require('./h3-video-common')

runH3Video({
  mode: 'txt2vid',
  prompt:
    process.env.H3_PROMPT ||
    'A small orange paper boat floating slowly on calm water at dusk, with a cliff in the background; gentle somber solo piano music, no speech.',
  outputPath: process.env.H3_OUTPUT
}).catch((error) => {
  console.error(error)
  process.exitCode = 1
})
