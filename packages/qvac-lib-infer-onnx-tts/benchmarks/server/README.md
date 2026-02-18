# TTS Addon Benchmark Server

Node.js server using `@qvac/tts-onnx` addon for benchmarking.

## Prerequisites

- Bare runtime
- `@qvac/tts-onnx` addon

## Installation

```bash
npm install
npm run setup:chatterbox  # Downloads Chatterbox ONNX models
```

## Usage

```bash
npm start  # Starts on port 8080
```

## Benchmarking Different Versions

To benchmark a different version of `@qvac/tts-onnx`:

1. Update the version in `package.json`:
   ```json
   "dependencies": {
     "@qvac/tts-onnx": "^0.2.0"
   }
   ```

2. Update the expected version in `../client/config/config-chatterbox.yaml`:
   ```yaml
   server:
     addon_version: "^0.2.0"
   ```

3. Reinstall dependencies and restart the server:
   ```bash
   npm install
   npm start
   ```

The server will automatically report the installed version in its health check and benchmark responses.

## API Endpoints

### GET /

Health check.

Response:
```json
{
  "message": "TTS Addon Benchmark Server is running",
  "implementation": "addon",
  "version": "0.1.0",
  "endpoints": {
    "/": "Health check",
    "/synthesize-chatterbox": "POST - Run Chatterbox TTS synthesis"
  }
}
```

### POST /synthesize-chatterbox

Run Chatterbox TTS synthesis.

Request:
```json
{
  "texts": ["Hello world"],
  "config": {
    "modelDir": "../shared-data/models/chatterbox",
    "language": "en",
    "sampleRate": 24000
  }
}
```

Response:
```json
{
  "outputs": [
    {
      "text": "Hello world",
      "sampleCount": 33075,
      "sampleRate": 24000,
      "durationSec": 1.5,
      "generationMs": 23.5,
      "rtf": 0.064
    }
  ],
  "implementation": "addon",
  "version": "0.1.0",
  "time": {
    "loadModelMs": 245.3,
    "totalGenerationMs": 23.5
  }
}
```

## Model Caching

The server caches loaded models in memory to avoid reloading on subsequent requests.
