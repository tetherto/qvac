'use strict'

const path = require('path')

const quickstartSectionTitle = 'Quickstart example'
const quickstartSectionDescription = 'Quickstart Description'
const quickstartProjectName = 'qvac-whispercpp-quickstart'

const quickstartPath = path.join(process.cwd(), 'examples', 'quickstart.js')
const readmePath = path.join(process.cwd(), 'README.md')

module.exports = {
  quickstartSectionTitle,
  quickstartSectionDescription,
  quickstartProjectName,
  quickstartPath,
  readmePath
}
