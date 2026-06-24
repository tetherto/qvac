#!/usr/bin/env node

const fs = require('fs')
const path = require('path')

// Read the prod.config.json file
const configPath = path.join(__dirname, '../../oss-actions/hyperbee-models-server/prod.config.json')
const config = JSON.parse(fs.readFileSync(configPath, 'utf8'))

// Transform the data
const modelStores = {}

config.drives.forEach(drive => {
  const tags = drive.tags

  // Build the model key to match the expected format
  const keyParts = [tags.name]

  // For models with external version, include it after name
  if (tags.externalVersion && tags.externalVersion !== '') {
    keyParts[0] = `${tags.name}-${tags.externalVersion}`
  }

  // Add internal version
  keyParts.push(tags.internalVersion)

  // Add params if not empty
  if (tags.params && tags.params !== '') {
    keyParts.push(tags.params)
  }

  // Add quantization if not empty
  if (tags.quantization && tags.quantization !== '') {
    keyParts.push(tags.quantization)
  }

  // For models that need additional uniqueness (like language pairs or types)
  if (tags.other && tags.other !== '') {
    keyParts.push(tags.other)
  } else if (tags.type && tags.name === 'whisper' && tags.type !== 'tiny-ggml') {
    // Special handling for whisper models with different types
    keyParts.push(tags.type)
  }

  const modelKey = keyParts.join('::')

  // Build tags array
  const tagsArray = []

  // Add function
  if (tags.function) tagsArray.push(tags.function)

  // Add type
  if (tags.type) tagsArray.push(tags.type)

  // Add model category based on function
  if (tags.function === 'generation') {
    tagsArray.push('llm')
  } else if (tags.function === 'embedding') {
    tagsArray.push('embedding')
  } else if (tags.function === 'transcription') {
    tagsArray.push('transcription')
  } else if (tags.function === 'translation') {
    tagsArray.push('translation')
  } else if (tags.function === 'vad') {
    tagsArray.push('vad')
  }

  // Add name
  if (tags.name) tagsArray.push(tags.name)

  // Add source type
  const firstSourceType = drive.models[0].source
  tagsArray.push(firstSourceType)

  // Add quantization if exists
  if (tags.quantization && tags.quantization !== '') {
    tagsArray.push(tags.quantization)
  }

  // Add params if exists
  if (tags.params && tags.params !== '') {
    tagsArray.push(tags.params)
  }

  // Handle source field - keep as array when multiple models, single object otherwise
  const source = drive.models.map(model => ({
    type: model.source,
    url: model.path
  }))

  // Create the model store entry
  modelStores[modelKey] = {
    type: tags.type,
    source,
    metadata: {
      parameters: tags.params || '',
      quantization: tags.quantization || '',
      function: tags.function || '',
      externalVersion: tags.externalVersion || '',
      other: tags.other || '',
      tags: tagsArray
    },
    addon: drive.addon
  }
})

// Write the output
const outputPath = path.join(__dirname, '../data/models.prod.json')
fs.writeFileSync(outputPath, JSON.stringify(modelStores, null, 2) + '\n')

console.log(`Transformed ${Object.keys(modelStores).length} models`)
console.log(`Output written to: ${outputPath}`)
