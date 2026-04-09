'use strict'

function getModelFiles (doc) {
  if (!doc) return []
  if (Array.isArray(doc.files)) {
    return doc.files.filter(file => file?.type === 'model')
  }
  if (doc.files && Array.isArray(doc.files.model)) {
    return doc.files.model
  }
  return []
}

module.exports = {
  mapByTags: (doc) => {
    return (doc.metadata && Array.isArray(doc.metadata.tags)) ? doc.metadata.tags.map(tag => ({ tag })) : []
  },
  mapByHuggingfaceURL: (doc) => {
    return getModelFiles(doc).reduce((acc, file) => {
      if (file.huggingfaceURL) {
        acc.push({ huggingfaceURL: file.huggingfaceURL })
      }
      return acc
    }, [])
  },
  mapByHuggingfaceFilename: (doc) => {
    return getModelFiles(doc).reduce((acc, file) => {
      if (file.huggingfaceFilename) {
        acc.push({ huggingfaceFilename: file.huggingfaceFilename })
      }
      return acc
    }, [])
  }
}
