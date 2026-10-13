'use strict'

const process = require('bare-process')
const { runH3Video } = require('./h3-video-common')

runH3Video({
  mode: 'txt2vid',
  prompt:
    process.env.H3_PROMPT ||
    'A small wooden Thai passenger motorboat with a cream canopy and one outboard motor glides slowly over clear turquoise water toward distant limestone islands in bright daylight. Gentle ripples, realistic travel film, steady camera, soft upbeat instrumental music, no speech.',
  outputPath: process.env.H3_OUTPUT
}).catch((error) => {
  console.error(error)
  process.exitCode = 1
})
