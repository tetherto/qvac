# QVAC Registry Server

Distributed model registry for QVAC. Download AI models for local inference, or contribute new models to the registry.

## For Users

### Downloading Models

Use the client library to query and download models:

```bash
npm install @tetherto/qvac-lib-registry-client
```

```javascript
const { QVACRegistryClient } = require('@tetherto/qvac-lib-registry-client')

const client = new QVACRegistryClient({
  registryCoreKey: process.env.QVAC_REGISTRY_CORE_KEY
})

// List all available models
const models = await client.findModels({})
console.log('Available models:', models)

// Download a model
const result = await client.downloadModel('hf/ggml-tiny.bin', 'hf', {
  outputFile: './whisper-tiny.ggml'
})

await client.close()
```

For full API documentation, see the [Client README](./client/README.md).

### Contributing Models

Want to add a model to the registry? See the [Model Submission Guide](./docs/MODEL_SUBMISSION_GUIDE.md).

---

## For Administrators

This section covers running and operating the registry server.

### Architecture

The registry uses an **Autobase multi-writer** architecture:

- **Autobase** linearizes operations from multiple writers into a deterministic HyperDB view
- **HyperDB** (extension disabled) provides queryable metadata with blob-pointer pattern
- **Hyperblobs** stores large model artifacts referenced by HyperDB records
- **Hyperswarm** handles replication for both Autobase writers and the view
- **Protomux RPC** exposes typed endpoints (`add-model`, `list-models`, `get-model`) for automation

### Features

- Runs as 1, 3, or more writers for high availability
- Autobase-backed HyperDB view keeps metadata consistent across replicas
- RPC API for model management (add/list/get)
- Direct file ingestion from HuggingFace, S3, or local sources
- Automatic Hyperblobs storage with content-addressable pointers
- Minimal configuration via `.env` (`REGISTRY_STORAGE`, `MODEL_DRIVES_STORAGE`, optional AWS/HF tokens)

### Quick Start (Single Writer)

#### 1. Install and Build

```bash
npm install
npm run build:spec
```

#### 2. Start the Registry

```bash
node scripts/bin.js run --storage ./corestore
```

Keys are auto-generated and saved to `.env` on first run (QVAC_AUTOBASE_KEY and QVAC_REGISTRY_CORE_KEY).

#### 3. Initialize Writer Authorization

Before adding models, authorize your writer keypair:

```bash
node scripts/bin.js init-writer --storage ./writer-storage
```

The command:

1. Derives (or loads) the writer keypair from the provided storage path
2. Prints the public key in both z-base-32 and hex formats
3. Appends the hex key to `QVAC_ALLOWED_WRITER_KEYS` inside `.env`

**Note**: Restart the registry service after updating `.env` for the changes to take effect.

#### 4. Add a Model

Use the same storage directory from `init-writer`:

```bash
npm run add-model -- https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-tiny.bin --storage ./writer-storage
```

Models are configured in `data/models.test.json`:

```json
{
  "source": "https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-tiny.bin",
  "engine": "@qvac/transcription-whispercpp",
  "quantization": "q8_0",
  "params": "tiny",
  "license": "MIT",
  "tags": ["transcription", "whisper"]
}
```

**Important**: The `--storage` parameter must match between `init-writer` and `add-model` to use the same keypair.

**Note**: To download from AWS S3 you need env vars configured or `~/.aws/credentials` set.

AWS_ACCESS_KEY_ID=...                 # AWS S3 access key
AWS_SECRET_ACCESS_KEY=...             # AWS S3 secret
AWS_REGION=eu-central-1               # AWS region (defaults to eu-central-1)

#### 5. Verify the Model

Use the client package to list all models and confirm the upload:

```bash
cd client
node examples/example.js
```

Output shows all registered models with metadata:

```
All models in registry: [
  {
    "path": "hf/ggml-tiny.bin",
    "name": "ggml-tiny",
    "engine": "@qvac/transcription-whispercpp",
    "quantization": "q8_0",
    "blobBinding": { "byteLength": 75000000, ... },
    ...
  }
]
Total models found: 1
```

See `client/examples/` for more examples:
- `example.js` - List and query models
- `download-model.js` - Download a single model
- `download-all-models.js` - Download all models

#### Next Steps

Re-run `init-writer` for each writer that should have `add-model` access (e.g., CI jobs, staging machines).

**For production deployment**, see [`docs/DEPLOYMENT_GUIDE.md`](./docs/DEPLOYMENT_GUIDE.md).

### Blind Peer Replication

The registry can optionally use [blind peers](https://github.com/holepunchto/blind-peer) to mirror all cores (Autobase view + Hyperblobs) and announce them on the public DHT. This provides high availability and geographic distribution.

**For setup instructions and trust configuration, see [docs/DEPLOYMENT_GUIDE.md](docs/DEPLOYMENT_GUIDE.md#step-2-start-blind-peers-for-high-availability).**

### Scripts Overview

#### Core Scripts

- **`bin.js`**: Starts the unified registry service
- **`add-model`**: Adds a model via RPC to the running service
- **`add-all-models`**: Bulk upload models from JSON config
- **`init-writer`**: Creates/loads a writer keypair and updates the allowlist
- **`sync-models`**: Syncs JSON config against database (adds new, updates metadata)
- **`build:spec`**: Builds database specification from schema

#### Utility Scripts

- **`cleanup`**: Removes temporary files and resets environment
- **`run-blind-peer`**: Starts a local blind peer and prints its public key for testing

### Development

#### Schema Changes

If you modify the database schema in `lib/generate-schema.js`:

1. Update the schema definition
2. Run `npm run build:spec` to regenerate specifications
3. Restart the service

#### Testing

Run tests to verify functionality:

```bash
npm test                  # All tests
npm run test:unit         # Unit tests only
npm run test:integration  # Integration tests only
```

#### Linting

```bash
npm run lint              # Check for linting errors
npm run lint:fix          # Auto-fix linting errors
```

#### Debug Logging

Enable debug logging to see detailed internal operations:

```bash
LOG_LEVEL=debug node scripts/bin.js run
```

This will output debug-level logs including:
- Registry initialization steps
- Corestore operations
- Hyperswarm connection events
- HyperDB operations
- Model upload/download progress

Available log levels (in order of verbosity):
- `debug`: Most verbose, includes all debug information
- `info`: Default level, shows informational messages
- `warn`: Only warnings and errors
- `error`: Only error messages

### Architecture Details

#### Storage Layout

```
corestore/
├── registry/           # Registry database namespace
│   └── db              # HyperDB core
└── blobs/              # Model blobs namespace
    └── blobs-models    # Single Hyperblobs core for all models
```

#### Data Flow

1. **Service starts**: Opens Autobase writers + HyperDB view, joins Hyperswarm
2. **Client connects**: Via view discovery key, replicates the read-only core
3. **Add model** (via RPC):
   - Downloads files from source
   - Uploads to Hyperblobs
   - Creates blob pointers
   - Inserts metadata into HyperDB
4. **Client queries**: Reads metadata from HyperDB
5. **Client downloads**: Uses blob pointers to fetch from Hyperblobs

#### External Pointer Pattern

Model metadata references blob storage:

```javascript
{
  name: 'whisper-futo',
  quantization: 'q8_0',
  blobsCoreKey: Buffer<abc123...>,  // Which Hyperblobs core
  files: [{
    type: 'model',
    filename: 'model.gguf',
    blobPointer: {                // Exact position in core
      blobKey: Buffer<abc123...>,
      blockOffset: 0,
      blockLength: 156,
      byteOffset: 0,
      byteLength: 75000000
    }
  }]
}
```

### Troubleshooting

#### "QVAC_AUTOBASE_KEY not set" warning

This is expected on first run. `node scripts/bin.js run` automatically generates an Autobase key and persists `QVAC_AUTOBASE_KEY` in `.env`.

#### "Could not connect to service" when adding model

Ensure at least one writer is running and exposing the RPC server key printed at startup.

#### Schema mismatch errors

Regenerate specs with `npm run build:spec` and restart the service.

#### Diagnostic Scripts

**`check-peers.js`**: Verifies DHT peer connectivity and sync status for a hypercore key. Reports remote/local lengths, contiguous gaps, and sync status.

```bash
node scripts/check-peers.js [--key <hypercore-key>]
```

**`ping-server.js`**: Pings a running registry server via RPC to check availability and retrieve server status (role, view key, lengths, connected peers).

```bash
node scripts/ping-server.js [--peer <peer-public-key>]
```

## License

Apache-2.0
