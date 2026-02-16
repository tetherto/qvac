# EmbedLlamacpp Benchmark Server

A Node.js server for benchmarking the `@qvac/embed-llamacpp` addon, built with `bare` runtime. Supports HuggingFace auto-downloaded models and P2P models via Hyperdrive.

## Features

- HTTP server using `bare-http1`
- Direct addon instantiation via ModelManager singleton
- P2P model loading via Hyperdrive (`@qvac/dl-hyperdrive`)
- VRAM management with automatic cleanup
- Input validation using Zod
- Comprehensive error handling and logging
- Configurable port via environment variable

## Prerequisites

- `bare` runtime
- GGUF embedding model (downloaded from HuggingFace or via P2P)

## Installation

```bash
cd benchmarks/server
npm install
```

## Usage

Start the server:

```bash
# Default port (7357)
npm start

# Custom port
PORT=8080 npm start
```

The server will start and listen for incoming requests.

## API Endpoints

### GET /

Health check endpoint.

Response:
```json
{
  "message": "EmbedLlamacpp Benchmark Server is running"
}
```

### GET /status

Get model status.

Response:
```json
{
  "message": "Model Status",
  "status": {
    "hasModel": true,
    "modelKey": "./models/gte-large_fp16.gguf:gpu:25",
    "isLoading": false
  }
}
```

### POST /run

Generate embeddings for input texts.

**HuggingFace Downloaded Model Request:**
```json
{
  "inputs": ["text to embed", "another text"],
  "config": {
    "modelName": "gte-large-f16.gguf",
    "diskPath": "/path/to/benchmarks/server/models",
    "device": "gpu",
    "gpu_layers": "99",
    "ctx_size": "512",
    "batch_size": "2048",
    "verbosity": "0"
  }
}
```

**P2P Hyperdrive Model Request:**
```json
{
  "inputs": ["text to embed", "another text"],
  "config": {
    "hyperdriveKey": "hd://{KEY}",
    "modelName": "gte-large_fp16.gguf",
    "device": "gpu",
    "gpu_layers": "99",
    "ctx_size": "512",
    "batch_size": "2048",
    "verbosity": "0"
  }
}
```

Response:
```json
{
  "data": {
    "outputs": [[0.1, 0.2, ...], [0.3, 0.4, ...]],
    "time": {
      "loadModelMs": 1234.56,
      "runMs": 567.89
    }
  }
}
```

## Configuration Parameters

| Parameter | Type | Description | Default |
|-----------|------|-------------|---------|
| `modelName` | `string` | GGUF model filename | Required |
| `diskPath` | `string` | Path to downloaded models directory | `./models/` |
| `hyperdriveKey` | `string` | P2P Hyperdrive key (for P2P models) | - |
| `device` | `string` | Device type (`cpu`, `gpu`) | `gpu` |
| `gpu_layers` | `string` | GPU layers to offload | `99` |
| `ctx_size` | `string` | Context window size | `512` |
| `batch_size` | `string` | Tokens for processing multiple prompts | `2048` |
| `verbosity` | `string` | Log verbosity (0-3) | `0` |

## Architecture

```
server/
├── index.js           # Entry point with port config, shutdown handling
├── package.json       # Dependencies
└── src/
    ├── server.js      # HTTP request handling
    ├── services/
    │   ├── modelManager.js   # Singleton for downloaded models + VRAM
    │   ├── p2pModelLoader.js # P2P Hyperdrive model loading
    │   └── runAddon.js       # Addon interface + routing logic
    ├── utils/
    │   ├── ApiError.js       # Error class
    │   ├── constants.js      # HTTP constants
    │   ├── helper.js         # JSON parsing utilities
    │   └── logger.js         # Logging
    └── validation/
        └── index.js          # Zod schemas
```

## Model Loading

The server routes model requests based on the presence of `hyperdriveKey`:

- **With `hyperdriveKey`**: Uses `p2pModelLoader.js` to load via Hyperdrive
- **Without `hyperdriveKey`**: Uses `modelManager.js` for downloaded GGUF files

Both loaders implement singleton caching to avoid reloading the same model.

## Error Handling

- Validation errors (400 Bad Request)
- Route not found (404 Not Found)  
- Server errors (500 Internal Server Error)

## License

Apache-2.0
