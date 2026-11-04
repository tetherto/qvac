'use strict'

const path = require('bare-path')
const process = require('bare-process')
const { runH3Video } = require('./h3-video-common')

runH3Video({
  mode: 'img2vid',
  imagePath: path.resolve(
    process.env.H3_INPUT_IMAGE || path.join(__dirname, '../assets/h3-keyframe-boat.png')
  ),
  prompt:
    process.env.H3_PROMPT ||
    'The wooden Thai passenger motorboat with a cream canopy and one outboard motor from the first frame glides slowly over clear turquoise water toward distant limestone islands. Gentle ripples and natural tropical light, realistic travel film, steady camera, soft upbeat instrumental music, no speech.',
  outputPath: process.env.H3_OUTPUT
}).catch((error) => {
  console.error(error)
  process.exitCode = 1
})
