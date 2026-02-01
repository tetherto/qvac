'use strict'

const fs = require('fs').promises
const path = require('path')
const { z } = require('zod')

const { parseCanonicalSource } = require('../lib/source-helpers')

const ENGINE_PATTERN = /^@qvac\/[a-z][a-z0-9-]*$/

function createModelSchema (validLicenses) {
  return z.object({
    source: z.string()
      .min(1, 'source is required')
      .refine(
        (val) => {
          try {
            parseCanonicalSource(val)
            return true
          } catch {
            return false
          }
        },
        { message: 'Invalid source URL (must be s3:// or https://huggingface.co/)' }
      ),

    engine: z.string()
      .min(1, 'engine is required')
      .regex(ENGINE_PATTERN, 'Invalid engine format (expected @qvac/<engine-name>)'),

    license: z.string()
      .min(1, 'license is required')
      .refine(
        (val) => validLicenses.has(val),
        (val) => ({ message: `Unknown license: "${val}" (not found in licenses.json)` })
      ),

    description: z.string().optional(),
    quantization: z.string().optional(),
    params: z.string().optional(),
    notes: z.string().optional(),
    tags: z.array(z.string()).optional(),
    deprecated: z.boolean().optional(),
    deprecationReason: z.string().optional(),
    replacedBy: z.string()
      .refine(
        (val) => {
          try {
            parseCanonicalSource(val)
            return true
          } catch {
            return false
          }
        },
        { message: 'replacedBy must be a valid source URL' }
      )
      .optional()
  })
}

async function loadValidLicenses () {
  const licensesPath = path.resolve(__dirname, '../data/licenses.json')
  const licensesContent = await fs.readFile(licensesPath, 'utf8')
  const licensesData = JSON.parse(licensesContent)
  return new Set(licensesData.map(l => l.spdxId))
}

function checkDuplicates (models) {
  const errors = []
  const seenSources = new Map()

  for (let i = 0; i < models.length; i++) {
    const source = models[i]?.source?.trim()
    if (!source) continue

    if (seenSources.has(source)) {
      errors.push(`[${i}] Duplicate source (first seen at index ${seenSources.get(source)}): ${source}`)
    } else {
      seenSources.set(source, i)
    }
  }

  return errors
}

function validateReplacedByReferences (models) {
  const errors = []
  const allSources = new Set(models.map(m => m.source))

  for (let i = 0; i < models.length; i++) {
    if (models[i].replacedBy && !allSources.has(models[i].replacedBy)) {
      errors.push(`[${i}] replacedBy references non-existent model: ${models[i].replacedBy}`)
    }
  }

  return errors
}

async function validateModelsJson (filePath) {
  const errors = []

  // Load models file
  let models
  try {
    const content = await fs.readFile(filePath, 'utf8')
    models = JSON.parse(content)
  } catch (err) {
    errors.push(`Failed to parse JSON: ${err.message}`)
    return { valid: false, errors, modelCount: 0 }
  }

  if (!Array.isArray(models)) {
    errors.push('Root element must be an array')
    return { valid: false, errors, modelCount: 0 }
  }

  // Load valid licenses
  let validLicenses
  try {
    validLicenses = await loadValidLicenses()
  } catch (err) {
    errors.push(`Failed to load licenses.json: ${err.message}`)
    return { valid: false, errors, modelCount: 0 }
  }

  // Create schema with license validation
  const ModelSchema = createModelSchema(validLicenses)
  const ModelsArraySchema = z.array(ModelSchema)

  // Validate with Zod
  const result = ModelsArraySchema.safeParse(models)

  if (!result.success) {
    for (const issue of result.error.issues) {
      const pathStr = issue.path.length > 0 ? `[${issue.path.join('.')}]` : ''
      errors.push(`${pathStr} ${issue.message}`)
    }
  }

  // Check for duplicates (cross-record validation)
  const duplicateErrors = checkDuplicates(models)
  errors.push(...duplicateErrors)

  // Check replacedBy references
  const replacedByErrors = validateReplacedByReferences(models)
  errors.push(...replacedByErrors)

  return {
    valid: errors.length === 0,
    modelCount: models.length,
    errors
  }
}

async function main () {
  const args = process.argv.slice(2)
  const fileArg = args.find(arg => arg.startsWith('--file='))
  const filePath = fileArg ? fileArg.split('=')[1] : './data/models.prod.json'

  const resolvedPath = path.resolve(filePath)
  const result = await validateModelsJson(resolvedPath)

  if (result.valid) {
    console.log(`✓ Valid: ${result.modelCount} model(s) in ${filePath}`)
  } else {
    console.error(`✗ Validation failed for ${filePath}`)
    console.error('')
    for (const error of result.errors) {
      console.error(`  ERROR: ${error}`)
    }
  }

  process.exit(result.valid ? 0 : 1)
}

if (require.main === module) {
  main().catch(err => {
    console.error('Fatal error:', err.message)
    process.exit(1)
  })
}

module.exports = { validateModelsJson, createModelSchema }
