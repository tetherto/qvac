# Whisper Addon Benchmark Server

A JS server for benchmarking Whisper transcription addons, built with `bare` runtime.

## Features

- HTTP server using `bare-http1`
- Input validation using Zod
- Comprehensive error handling and logging
- Support for Whisper transcription addons
- Benchmarking capabilities for model performance

## Prerequisites

- `bare` runtime
- Whisper transcription addons

## Installation

```bash
# Clone the repository
git clone https://github.com/tetherto/qvac-lib-inference-addon-mlc-whisper.git
cd qvac-lib-inference-addon-mlc-whisper/benchmarks/server

# Install dependencies
npm install
```

## Usage

Start the server:

```bash
npm start
```

The server will start and listen for incoming requests.

### API Endpoints

#### GET /

Health check endpoint that returns a status message.

Response:

```json
{
  "message": "Whisper Addon Benchmark Server is running"
}
```

#### POST /run

Run inference with the Whisper model.

Sample request body:

```json
{
  "inputs": ["some/path/to/audio.raw", "some/path/to/audio2.raw"], // array of paths to audio files to transcribe
  "lib": "@tetherto/qvac-lib-inference-addon-mlc-whisper-tiny-q0f32", // the library to use
  "version": "1.0.0", // the version of the library to use (optional)
  "params": {
    "modeParams": {
      "mode": "batch",
      "updateFrequency": "on_end",
      "outputFormat": "plaintext",
      "minSeconds": 0,
      "maxSeconds": 2
    }
  },
  "opts": {}, // Options for the addon (optional)
  "config": {
    "sampleRate": 16000 // the sample rate of the audio files (optional)
  }
}
```

Sample response body:

```json
{
  "outputs": ["HELLO", "WORLD"],
  "version": "1.0.0",
  "time": {
    "loadModelMs": 5500.68625,
    "runMs": 864.597875
  }
}
```

### Error Handling

The server provides detailed error messages for various scenarios:

- Validation errors (400 Bad Request)
- Route not found (404 Not Found)
- Server errors (500 Internal Server Error)

## License

This project is licensed under the Apache-2.0 License - see the LICENSE file for details.

For any questions or issues, please open an issue on the GitHub repository.
