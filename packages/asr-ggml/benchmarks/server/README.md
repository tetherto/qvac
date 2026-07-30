# ASR GGML Benchmark Server

A JS server for benchmarking the `@qvac/asr-ggml` addon (Whisper + NVIDIA
Parakeet engines), built with the `bare` runtime.

## Features

- HTTP server using `bare-http1`
- Input validation using Zod (engine-discriminated union)
- Comprehensive error handling and logging
- One `/run` endpoint serving both engines, selected by the required
  top-level `engine` key
- Benchmarking capabilities for model performance

## Prerequisites

- `bare` runtime
- The `@qvac/asr-ggml` addon, installed from the in-repo package with
  `npm install ../../` (against a local prebuild)

`@qvac/asr-ggml` is deliberately NOT listed in `dependencies`. The unified
package has not had its first npm release yet — the registry carries only a
`0.0.0` placeholder — so a registry range such as `^0.1.0` makes a plain
`npm install` fail with `ETARGET` and takes the whole accuracy-benchmark lane
down before the server ever starts. The addon is therefore installed from the
local source tree, which is the shape the parakeet benchmark server used.
Add a registry dependency back only once `@qvac/asr-ggml` is published.

## Installation

```bash
# Clone the repository
git clone https://github.com/tetherto/qvac.git
cd qvac/packages/asr-ggml/benchmarks/server

# Install dependencies, then the addon from the local package
npm install
npm install ../../
```

## Usage

Start the server:

```bash
npm start
```

The server will start and listen on port 8080 (override with `PORT`).

### API Endpoints

#### GET /

Health check endpoint that returns a status message.

Response:

```json
{
  "message": "ASR GGML Benchmark Server is running"
}
```

#### POST /run

Run inference. The body must carry `engine: "whisper" | "parakeet"`; the
rest of the payload is engine-specific.

Whisper request body:

```json
{
  "engine": "whisper",
  "inputs": ["some/path/to/audio.raw", "some/path/to/audio2.raw"],
  "whisper": {
    "lib": "@qvac/asr-ggml",
    "version": "0.1.0"
  },
  "config": {
    "path": "./models/ggml-tiny.bin",
    "whisperConfig": {
      "vad_model_path": "./models/ggml-silero-v5.1.2.bin",
      "language": "",
      "audio_format": "f32le"
    },
    "sampleRate": 16000,
    "streaming": false,
    "streamingChunkSize": 64000
  }
}
```

Parakeet request body (`config.path` is a single `.gguf` checkpoint; the
model type is auto-detected from the GGUF metadata):

```json
{
  "engine": "parakeet",
  "inputs": ["some/path/to/audio.raw"],
  "parakeet": {
    "lib": "@qvac/asr-ggml"
  },
  "config": {
    "path": "./models/parakeet-tdt-0.6b-v3.f16.gguf",
    "parakeetConfig": {
      "modelType": "tdt",
      "maxThreads": 4,
      "useGPU": false,
      "timestampsEnabled": true
    },
    "sampleRate": 16000,
    "streaming": false,
    "streamingChunkSize": 64000
  }
}
```

Sample response body (`whisperVersion` / `parakeetVersion` mirrors the
engine that ran):

```json
{
  "data": {
    "outputs": ["HELLO", "WORLD"],
    "whisperVersion": "0.1.0",
    "time": {
      "loadModelMs": 5500.68625,
      "runMs": 864.597875
    }
  }
}
```

#### POST /live

Whisper-only endpoint that accepts base64 audio for interactive
live-transcription experiments (see `src/services/runLiveAudio.js`).

### Error Handling

The server provides detailed error messages for various scenarios:

- Validation errors / missing `engine` key (400 Bad Request)
- Route not found (404 Not Found)
- Server errors (500 Internal Server Error)

## License

This project is licensed under the Apache-2.0 License - see the LICENSE file for details.

For any questions or issues, please open an issue on the GitHub repository.
