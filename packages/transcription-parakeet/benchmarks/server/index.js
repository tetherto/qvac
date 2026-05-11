'use strict'

const { server } = require('./src/server')
const process = require('bare-process')

const PORT = process.env?.PORT || 8080

server.listen(PORT, () => {
  console.log(`Parakeet Addon Benchmark Server listening on port ${PORT}`)
})
