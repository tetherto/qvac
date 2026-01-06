'use strict'

function getRegistryFileType (filename) {
  let type
  if (filename.includes('tokenizer') && filename.endsWith('.json')) {
    type = 'tokenizer'
  } else if (filename.endsWith('.json')) {
    type = 'config'
  } else {
    type = 'model'
  }
  return type
}

module.exports = {
  getRegistryFileType
}
