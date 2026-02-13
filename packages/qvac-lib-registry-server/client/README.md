# @tetherto/qvac-lib-registry-client

Read-only client library for querying the QVAC Registry. It replicates the registry HyperDB via Hyperswarm and provides APIs for searching and retrieving model information.

## Features

- Establishes replication connection to the QVAC Registry swarm.
- Supports querying specific models by path, engine, name, and quantization.
- Downloads actual model files from Hyperblobs cores via blind peers.
- Provides indexed search methods for efficient lookups.
- Graceful disconnection from the swarm.

## Installation

```bash
npm install @tetherto/qvac-lib-registry-client
```

Ensure the registry core key is available via environment variables or provided via options.

## Usage

### Basic Example

```javascript
'use strict'
const { QVACRegistryClient } = require('@tetherto/qvac-lib-registry-client')

async function main () {
  const client = new QVACRegistryClient({
    registryCoreKey: process.env.QVAC_REGISTRY_CORE_KEY
  })

  const models = await client.findModels({})
  console.log('All models:', models)

  if (models.length > 0) {
    const model = await client.getModel(models[0].path, models[0].source)
    console.log('Model:', model)
  }

  await client.close()
}
main().catch(console.error)
```

### Available Methods

#### Lifecycle

- `ready()`: Initialize client and connect to registry. Triggered from constructor asynchronously.
- `close()`: Close connection to registry and corestore.

#### Metadata Queries

- `getModel(path, source)`: Retrieves a specific model's metadata by path and source.
- `findModels(query)`: General search with filters. Supports path prefix queries for finding model shards.
- `findModelsByEngine(query)`: Searches models by engine (indexed).
- `findModelsByName(query)`: Searches models by name (indexed).
- `findModelsByQuantization(query)`: Searches models by quantization (indexed).

Query format for range queries:

```javascript
// Exact match
const models = await client.findModelsByEngine({
  gte: { engine: '@qvac/transcription-whispercpp' },
  lte: { engine: '@qvac/transcription-whispercpp' }
})

// Prefix match (all models with path starting with 'hf/')
const hfModels = await client.findModels({
  gte: { path: 'hf/' },
  lte: { path: 'hf/\uffff' }
})
```

#### File Downloads

- `downloadModel(path, source, options)`: Downloads actual model file from Hyperblobs cores.
  - `path`: Registry path of the model (e.g., 'hf/model.gguf')
  - `source`: Source identifier (e.g., 'hf')
  - `options`:
    - `timeout`: Download timeout in ms (default: 30000)
    - `outputFile`: Optional file path to save directly to disk
  - Returns: `{ model: QVACModelEntry, artifact: QVACDownloadedArtifact }`
    - If `outputFile` provided: `artifact = { path: '/path/to/file' }`
    - Otherwise: `artifact = { stream: ReadableStream }`

Example - Download to file:

```javascript
const result = await client.downloadModel('hf/ggml-tiny.bin', 'hf', {
  outputFile: './downloaded/whisper-tiny.ggml',
  timeout: 60000
})
console.log('Downloaded to:', result.artifact.path)
console.log('Model metadata:', result.model)
```

Example - Download as stream:

```javascript
const result = await client.downloadModel('hf/ggml-tiny.bin', 'hf')
const fs = require('fs')
result.artifact.stream.pipe(fs.createWriteStream('./model.ggml'))
```

## CLI

The package includes a CLI for querying and downloading models from the registry.

```bash
npx qvac-registry --help
```

### List models

By default, `list` prints a compact table with path, source, quantization, and params:

```bash
$ qvac-registry list
Found 195 model(s)

PATH	SOURCE	QUANT	PARAMS
BSC-LT/salamandraTA-2B-instruct-GGUF/blob/60046856fcac87c47fb0c706e994e70f01eda62b/salamandrata_2b_inst_q4.gguf	hf	q4	2B
Qwen/Qwen3-8B-GGUF/blob/main/Qwen3-8B-Q4_K_M.gguf	hf	q4_k_m	8B
ggerganov/whisper.cpp/resolve/5359861c739e955e79d9a303bcbc70fb988958b1/ggml-tiny-q8_0.bin	hf	q8_0
...
```

Use `--full` for detailed output per model:

```bash
$ qvac-registry list --full
Found 195 model(s)

  Qwen/Qwen3-8B-GGUF/blob/main/Qwen3-8B-Q4_K_M.gguf
    source:       hf
    engine:       @qvac/llm-llamacpp
    quantization: q4_k_m
    params:       8B
    size:         4.68 GB
    license:      Apache-2.0
    sha256:       d98cdcbd03e17ce47681435b5150e34c1417f50b5c0019dd560e4882c5745785
...
```

### Filter models

```bash
# By engine
$ qvac-registry list --engine @qvac/transcription-whispercpp

# By quantization
$ qvac-registry list -q q4_k_m

# By name (case-sensitive prefix match on filename)
$ qvac-registry list -n Qwen3

# Combined
$ qvac-registry list -e @qvac/llm-llamacpp -q q4_k_m --full
```

### Get a specific model

```bash
$ qvac-registry get \
    "ggerganov/whisper.cpp/resolve/5359861c739e955e79d9a303bcbc70fb988958b1/ggml-tiny-q8_0.bin" hf

  ggerganov/whisper.cpp/resolve/5359861c739e955e79d9a303bcbc70fb988958b1/ggml-tiny-q8_0.bin
    source:       hf
    engine:       @qvac/transcription-whispercpp
    quantization: q8_0
    size:         41.52 MB
    license:      MIT
    sha256:       ...
```

### Download a model

```bash
$ qvac-registry download \
    "ggerganov/whisper.cpp/resolve/5359861c739e955e79d9a303bcbc70fb988958b1/ggml-tiny-q8_0.bin" hf \
    --output ./ggml-tiny-q8_0.bin
Downloading ... -> /absolute/path/ggml-tiny-q8_0.bin
Download complete: 41.52 MB
```

### JSON output

All commands support `--json` for machine-readable output:

```bash
$ qvac-registry list --engine @qvac/transcription-whispercpp --json | jq '.[0].path'
```

### Global flags

```
--key|-k [key]        Registry core key (overrides QVAC_REGISTRY_CORE_KEY env)
--storage|-s [path]   Client storage path
--verbose|-v          Enable verbose/debug logging
```

## Examples

See the `examples/` folder for complete working examples:

- `example.js`: List models, query by engine/name/quantization, find shards
- `download-model.js`: Download a single model to disk
- `download-all-models.js`: Download all models in the registry

Run examples:

```bash
cd client
node examples/example.js
node examples/download-model.js
node examples/download-all-models.js
```

## Configuration

- `storage`: Path for local storage (defaults to temporary directory in `os.tmpdir()`, or `REGISTRY_STORAGE` env var if set).
- `registryCoreKey`: z-base-32 or hex string of the hypercore key (defaults to `QVAC_REGISTRY_CORE_KEY` env var).
- `logger`: Logger configuration object
  - `level`: Log level ('debug', 'info', 'warn', 'error')
  - `name`: Logger name for identification

### Storage Configuration

By default, the client uses a temporary directory created in `os.tmpdir()` with a unique name. Temporary storage is used for replicating registry metadata and is separate from downloaded model files. The temporary storage is not automatically cleaned up on exit and should be manually removed if needed. If you need persistent storage or want to control the location:

```javascript
const client = new QVACRegistryClient({
  registryCoreKey: process.env.QVAC_REGISTRY_CORE_KEY,
  storage: '/path/to/persistent/storage'
})
```

### Environment Variables

- `QVAC_REGISTRY_CORE_KEY`: Core key for accessing the registry hypercore
- `REGISTRY_STORAGE`: Path for local storage (optional, overrides temporary directory default)

## Error Handling

The client uses custom error codes in the range 19001-20000. All errors extend `QvacErrorRegistryClient`.

### Error Codes

| Code | Name | Description | When Thrown |
|------|------|-------------|-------------|
| 19001 | FAILED_TO_CONNECT | Connection to registry failed | Missing core key, network issues during initialization |
| 19002 | FAILED_TO_CLOSE | Failed to close registry cleanly | Resource cleanup errors during shutdown |
| 19003 | MODEL_NOT_FOUND | Model not found or invalid | Model doesn't exist or missing blob binding |

### Error Handling Example

```javascript
const { QVACRegistryClient } = require('@tetherto/qvac-lib-registry-client')
const { QvacErrorRegistryClient } = require('@tetherto/qvac-lib-registry-client/utils/error')

async function handleErrors () {
  const client = new QVACRegistryClient({
    registryCoreKey: process.env.QVAC_REGISTRY_CORE_KEY
  })

  try {
    const model = await client.getModel('hf/model-name.Q4_K_M.gguf', 'hf')
    if (!model) {
      console.log('Model not found')
    } else {
      console.log('Model found:', model)
    }
  } catch (error) {
    if (error instanceof QvacErrorRegistryClient) {
      console.error(`Registry error [${error.code}]:`, error.message)
    } else {
      console.error('Unexpected error:', error)
    }
  } finally {
    await client.close()
  }
}
```

## License

Apache-2.0
