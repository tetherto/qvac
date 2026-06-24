'use strict'

const fs = require('fs').promises
const path = require('path')
const { z } = require('zod')

const { parseCanonicalSource } = require('../lib/source-helpers')
const { baseModelFields } = require('../lib/model-schema')

const ENGINE_PATTERN = /^@qvac\/[a-z][a-z0-9-]*$/
const S3_DATE_FOLDER_PATTERN = /\/\d{4}-\d{2}-\d{2}\//
const HF_COMMIT_HASH_PATTERN = /huggingface\.co\/.+\/(resolve|blob)\/([a-f0-9]{40})\//

const SOURCE_REFINE = (val) => {
  try {
    parseCanonicalSource(val)
    return true
  } catch {
    return false
  }
}

const S3_NO_BUCKET = (val) => {
  if (!val.startsWith('s3://')) return true
  const parsed = parseCanonicalSource(val)
  return parsed.bucket === null
}

let _s3LegacyPaths = null
function loadS3LegacyPaths () {
  if (!_s3LegacyPaths) {
    const legacyPathsFile = path.resolve(__dirname, '../data/s3-legacy-paths.json')
    _s3LegacyPaths = new Set(JSON.parse(require('fs').readFileSync(legacyPathsFile, 'utf8')))
  }
  return _s3LegacyPaths
}

let _hfLegacyMainSources = null
function loadHfLegacyMainSources () {
  if (!_hfLegacyMainSources) {
    const legacyFile = path.resolve(__dirname, '../data/hf-legacy-main-sources.json')
    _hfLegacyMainSources = new Set(JSON.parse(require('fs').readFileSync(legacyFile, 'utf8')))
  }
  return _hfLegacyMainSources
}

const S3_DATE_FOLDER = (val) => {
  if (!val.startsWith('s3://')) return true
  if (loadS3LegacyPaths().has(val)) return true
  return S3_DATE_FOLDER_PATTERN.test(val)
}

const HF_COMMIT_PIN = (val) => {
  if (!val.startsWith('https://huggingface.co/')) return true
  if (loadHfLegacyMainSources().has(val)) return true
  return HF_COMMIT_HASH_PATTERN.test(val)
}

// CI-specific fields: layer refinements on top of shared base
const ciFields = {
  ...baseModelFields,
  source: baseModelFields.source
    .refine(SOURCE_REFINE, { message: 'Invalid source URL (must be s3:// or https://huggingface.co/)' })
    .refine(S3_NO_BUCKET, { message: 'S3 URLs must not contain a bucket name. Use s3:///key format; bucket is resolved from QVAC_S3_BUCKET env var.' })
    .refine(S3_DATE_FOLDER, { message: 'S3 URLs must include a date folder (YYYY-MM-DD) in the path. Upload artifacts to a dated directory to ensure registry consistency when models are updated.' })
    .refine(HF_COMMIT_PIN, { message: 'HuggingFace source URLs must pin to a specific commit hash, not a branch name. Use https://huggingface.co/<org>/<repo>/resolve/<full-commit-sha>/<file>' }),

  engine: baseModelFields.engine
    .regex(ENGINE_PATTERN, 'Invalid engine format (expected @qvac/<engine-name>)'),

  replacedBy: z.string()
    .refine(SOURCE_REFINE, { message: 'replacedBy must be a valid source URL' })
    .optional()
}

function createModelSchema (validLicenses) {
  return z.object({
    ...ciFields,
    licenseId: ciFields.licenseId.refine(
      (val) => validLicenses.has(val),
      (val) => ({ message: `Unknown license: "${val}" (not found in licenses.json)` })
    )
  })
}

function createDeprecatedModelSchema () {
  return z.object(ciFields)
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

  // Validate active and deprecated models with different schemas
  const ActiveSchema = createModelSchema(validLicenses)
  const DeprecatedSchema = createDeprecatedModelSchema()

  for (let i = 0; i < models.length; i++) {
    const schema = models[i].deprecated === true ? DeprecatedSchema : ActiveSchema
    const result = schema.safeParse(models[i])

    if (!result.success) {
      for (const issue of result.error.issues) {
        const pathStr = issue.path.length > 0 ? `[${i}.${issue.path.join('.')}]` : `[${i}]`
        errors.push(`${pathStr} ${issue.message}`)
      }
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
