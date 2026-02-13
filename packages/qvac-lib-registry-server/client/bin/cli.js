#!/usr/bin/env node
'use strict'

const { command, flag, arg, summary, header, footer, description } = require('paparam')
const { QVACRegistryClient } = require('../index')
const IdEnc = require('hypercore-id-encoding')
const path = require('path')

const VERSION = require('../package.json').version

// --- Helpers ---

function createClient (parentFlags) {
  const opts = {}
  if (parentFlags.key) opts.registryCoreKey = parentFlags.key
  if (parentFlags.storage) opts.storage = parentFlags.storage
  if (parentFlags.verbose) {
    opts.logger = { level: 'debug', enabled: true }
  } else {
    opts.logger = { enabled: false }
  }
  return new QVACRegistryClient(opts)
}

function getRootFlags (cmd) {
  let current = cmd
  while (current.parent) current = current.parent
  return current.flags || {}
}

function formatSize (bytes) {
  if (!bytes) return 'N/A'
  if (bytes >= 1024 * 1024 * 1024) return (bytes / (1024 * 1024 * 1024)).toFixed(2) + ' GB'
  if (bytes >= 1024 * 1024) return (bytes / (1024 * 1024)).toFixed(2) + ' MB'
  if (bytes >= 1024) return (bytes / 1024).toFixed(2) + ' KB'
  return bytes + ' B'
}

function printModelCompact (model) {
  const parts = [model.path, model.source]
  if (model.quantization) parts.push(model.quantization)
  if (model.params) parts.push(model.params)
  console.log(parts.join('\t'))
}

function printModelFull (model, opts = {}) {
  const blob = model.blobBinding || {}
  const coreKey = blob.coreKey ? IdEnc.normalize(blob.coreKey) : 'N/A'

  console.log(`  ${model.path}`)
  console.log(`    source:       ${model.source}`)
  console.log(`    engine:       ${model.engine}`)
  if (model.name) console.log(`    name:         ${model.name}`)
  if (model.quantization) console.log(`    quantization: ${model.quantization}`)
  if (model.params) console.log(`    params:       ${model.params}`)
  console.log(`    size:         ${formatSize(blob.byteLength || model.sizeBytes)}`)
  if (model.licenseId || model.license) console.log(`    license:      ${model.licenseId || model.license}`)
  if (blob.sha256 || model.sha256) console.log(`    sha256:       ${blob.sha256 || model.sha256}`)
  if (opts.verbose && model.description) console.log(`    description:  ${model.description}`)
  if (opts.verbose) console.log(`    blob core:    ${coreKey}`)
  if (model.deprecated) console.log('    deprecated:   true')
  console.log()
}

async function withClient (cmd, fn) {
  const rootFlags = getRootFlags(cmd)
  const client = createClient(rootFlags)
  try {
    await fn(client, rootFlags)
  } finally {
    await client.close()
  }
}

// --- Commands ---

const listCmd = command('list',
  summary('List models from the registry'),
  description('List all models or filter by name, engine, or quantization.'),
  flag('--name|-n [name]', 'Filter by model name (partial match)'),
  flag('--engine|-e [engine]', 'Filter by engine (exact match)'),
  flag('--quantization|-q [quantization]', 'Filter by quantization (partial match)'),
  flag('--full', 'Show full model details'),
  flag('--include-deprecated', 'Include deprecated models'),
  flag('--json', 'Output as JSON'),
  async function (cmd) {
    await withClient(cmd, async (client, rootFlags) => {
      const { flags } = cmd
      const params = {}
      if (flags.name) params.name = flags.name
      if (flags.engine) params.engine = flags.engine
      if (flags.quantization) params.quantization = flags.quantization
      if (flags.includeDeprecated) params.includeDeprecated = true

      const hasFilters = flags.name || flags.engine || flags.quantization
      let models

      if (hasFilters) {
        models = await client.findBy(params)
      } else {
        models = await client.findModels({}, { includeDeprecated: !!flags.includeDeprecated })
      }

      if (flags.json) {
        const out = models.map(m => ({
          ...m,
          blobBinding: m.blobBinding
            ? { ...m.blobBinding, coreKey: m.blobBinding.coreKey ? IdEnc.normalize(m.blobBinding.coreKey) : undefined }
            : undefined
        }))
        console.log(JSON.stringify(out, null, 2))
        return
      }

      console.log(`Found ${models.length} model(s)\n`)

      if (flags.full) {
        for (const m of models) {
          printModelFull(m, { verbose: rootFlags.verbose })
        }
      } else {
        console.log(['PATH', 'SOURCE', 'QUANT', 'PARAMS'].join('\t'))
        for (const m of models) {
          printModelCompact(m)
        }
      }
    })
  }
)

const getCmd = command('get',
  summary('Get a specific model by path and source'),
  arg('<path>', 'Model path (e.g. hf/org/repo/file.gguf)'),
  arg('<source>', 'Model source (e.g. hf, s3)'),
  flag('--json', 'Output as JSON'),
  async function (cmd) {
    await withClient(cmd, async (client, rootFlags) => {
      const modelPath = cmd.args.path
      const source = cmd.args.source

      const model = await client.getModel(modelPath, source)
      if (!model) {
        console.error(`Model not found: ${modelPath} (source: ${source})`)
        process.exit(1)
      }

      if (cmd.flags.json) {
        const out = {
          ...model,
          blobBinding: model.blobBinding
            ? { ...model.blobBinding, coreKey: model.blobBinding.coreKey ? IdEnc.normalize(model.blobBinding.coreKey) : undefined }
            : undefined
        }
        console.log(JSON.stringify(out, null, 2))
        return
      }

      printModelFull(model, { verbose: rootFlags.verbose })
    })
  }
)

const downloadCmd = command('download',
  summary('Download a model from the registry'),
  arg('<path>', 'Model path'),
  arg('<source>', 'Model source (e.g. hf, s3)'),
  flag('--output|-o <file>', 'Output file path (required)'),
  flag('--timeout|-t [ms]', 'Download timeout in ms (default: 30000)'),
  async function (cmd) {
    await withClient(cmd, async (client) => {
      const { flags } = cmd
      const modelPath = cmd.args.path
      const source = cmd.args.source

      if (!flags.output) {
        console.error('--output|-o is required')
        process.exit(1)
      }

      const outputFile = path.resolve(flags.output)
      const opts = { outputFile }
      if (flags.timeout) opts.timeout = parseInt(flags.timeout, 10)

      console.log(`Downloading ${modelPath} (${source}) -> ${outputFile}`)

      const result = await client.downloadModel(modelPath, source, opts)
      const size = result.model.blobBinding?.byteLength || 0

      console.log(`Download complete: ${formatSize(size)}`)
    })
  }
)

// --- Root command ---

const cmd = command('qvac-registry',
  header(`qvac-registry v${VERSION}`),
  summary('QVAC Model Registry CLI'),
  footer('Set QVAC_REGISTRY_CORE_KEY env var or use --key to specify the registry core key.'),
  flag('--key|-k [key]', 'Registry core key (overrides QVAC_REGISTRY_CORE_KEY env)'),
  flag('--storage|-s [path]', 'Client storage path'),
  flag('--verbose|-v', 'Enable verbose/debug logging'),
  listCmd,
  getCmd,
  downloadCmd
)

cmd.parse()
