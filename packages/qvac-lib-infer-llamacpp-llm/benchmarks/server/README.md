# LLM Addon Benchmark Server

A JS server for benchmarking LLM addons, built with `bare` runtime.

## Features

- HTTP server using `bare-http1`
- Input validation using Zod
- Comprehensive error handling and logging
- Support for LLM translation addons
- Benchmarking capabilities for model performance
- P2P model loading via Hyperdrive

## Prerequisites

- `bare` runtime
- LLM translation addons

## Installation

```bash
# Clone the repository
git clone https://github.com/tetherto/qvac-lib-inference-addon-mlc-llama.git
cd qvac-lib-inference-addon-mlc-llama/benchmarks/server

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
  "message": "LLM Addon Benchmark Server is running"
}
```

#### POST /run

Run inference with the LLM model.

**Pre-installed Model Mode (Default):**

```json
{
  "inputs": ["prompt"],
  "lib": "@tetherto/qvac-lib-inference-addon-mlc-llama-3_2_1b-q4f16_1",
  "params": {
    "num_return_sequences": 1
  },
  "opts": {
    "stats": true,
    "context_window_size": 32768,
    "prefill_chunk_size": 8096,
    "temperature": 0.7,
    "max_tokens": 1000,
    "top_p": 0.9,
    "do_sample": true,
    "system_message": "You are a helpful assistant."
  }
}
```

**P2P Model Mode:**

```json
{
  "inputs": ["prompt"],
  "hyperdriveKey": "hd://b11388de0e9214d8c2181eae30e31bcd49c48b26d621b353ddc7f01972dddd76",
  "modelName": "medgemma-4b-it-Q4_1.gguf",
  "modelConfig": {
    "gpu_layers": "99",
    "ctx_size": "2048",
    "temp": "0.7",
    "top_p": "0.9",
    "system_prompt": "You are a helpful assistant."
  },
  "params": { "num_return_sequences": 1 },
  "opts": {
    "stats": true,
    "context_window_size": 8000,
    "prefill_chunk_size": 1024,
    "temperature": 0.7,
    "max_tokens": 500,
    "top_p": 0.9,
    "do_sample": true,
    "system_message": "You are a helpful assistant."
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
