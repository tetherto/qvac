# Parakeet Addon Benchmark Server

A JS server for benchmarking Parakeet transcription addons, built with `bare` runtime.

## Features

- HTTP server using `bare-http1`
- Input validation using Zod
- Comprehensive error handling and logging
- Support for Parakeet transcription addons (NVIDIA NeMo ONNX models)
- Benchmarking capabilities for model performance

## Prerequisites

- `bare` runtime
- Parakeet transcription addons

## Installation

```bash
# Clone the repository
git clone https://github.com/tetherto/qvac.git
cd qvac/packages/qvac-lib-infer-parakeet/benchmarks/server

# Install dependencies
npm install
```

## Usage

Start the server:

```bash
npm start
```

The server will start and listen for incoming requests on port 8080 (or the port specified by the `PORT` environment variable).

### API Endpoints

#### GET /

Health check endpoint that returns a status message.

Response:

```json
{
  "message": "Parakeet Addon Benchmark Server is running"
}
```

#### POST /run

Run inference with the Parakeet model.

Sample request body:

```json
{
  "inputs": ["some/path/to/audio.raw", "some/path/to/audio2.raw"],
  "parakeet": {
    "lib": "@qvac/transcription-parakeet",
    "version": "0.1.0"
  },
  "config": {
    "path": "./path/to/parakeet-tdt-0.6b-v3-onnx",
    "parakeetConfig": {
      "modelType": "tdt",
      "maxThreads": 4,
      "useGPU": false,
      "captionEnabled": false,
      "timestampsEnabled": true
    },
    "sampleRate": 16000,
    "streaming": false,
    "streamingChunkSize": 64000
  },
  "opts": {}
}
```

Sample response body:

```json
{
  "data": {
    "outputs": ["HELLO", "WORLD"],
    "parakeetVersion": "0.1.0",
    "time": {
      "loadModelMs": 5500.68625,
      "runMs": 864.597875
    }
  }
}
```

### Configuration Options

#### Parakeet Config

| Option | Type | Default | Description |
|--------|------|---------|-------------|
| `modelType` | string | `"tdt"` | Model type: `tdt`, `ctc`, `eou`, or `sortformer` |
| `maxThreads` | number | `4` | Maximum CPU threads for inference |
| `useGPU` | boolean | `false` | Enable GPU acceleration |
| `captionEnabled` | boolean | `false` | Enable caption/subtitle mode |
| `timestampsEnabled` | boolean | `true` | Include timestamps in output |
| `seed` | number | `-1` | Random seed (-1 for random) |

#### Streaming Options

| Option | Type | Default | Description |
|--------|------|---------|-------------|
| `streaming` | boolean | `false` | Enable streaming mode for chunked processing |
| `streamingChunkSize` | number | `16384` | Chunk size in bytes for streaming mode |

### Error Handling

The server provides detailed error messages for various scenarios:

- Validation errors (400 Bad Request)
- Route not found (404 Not Found)
- Server errors (500 Internal Server Error)

## Model Types

| Type | Description |
|------|-------------|
| `tdt` | Token-and-Duration Transducer (default, best for general use) |
| `ctc` | Connectionist Temporal Classification (faster, simpler) |
| `eou` | End-of-Utterance detection |
| `sortformer` | Sortformer architecture |

## License

This project is licensed under the Apache-2.0 License - see the LICENSE file for details.

For any questions or issues, please open an issue on the GitHub repository.
