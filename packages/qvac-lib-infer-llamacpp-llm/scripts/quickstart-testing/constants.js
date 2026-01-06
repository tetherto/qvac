'use strict'

const path = require('path')

const quickstartSectionTitle = 'Quickstart Example'
const quickstartSectionDescription = 'Follow these simple steps to run the Quickstart demo using the Hyperdrive loader:'
const quickstartProjectName = 'qvac-llm-quickstart'
const quickstartPath = path.join(__dirname, '..', '..', 'examples', 'quickstart.js')
const readmePath = path.join(__dirname, '..', '..', 'README.md')

module.exports = {
  quickstartSectionTitle,
  quickstartSectionDescription,
  quickstartProjectName,
  quickstartPath,
  readmePath
}
