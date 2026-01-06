# Embeddings Addon Benchmark Server

A JS server for benchmarking Embeddings addons, built with `bare` runtime.

## Features

- HTTP server using `bare-http1`
- Input validation using Zod
- Comprehensive error handling and logging
- Support for GTE-Large embeddings addons
- Benchmarking capabilities for model performance

## Prerequisites

- `bare` runtime
- GTE-Large embeddings addons

## Installation

```bash
# Clone the repository
git clone https://github.com/tetherto/qvac-lib-inference-embeddings-mlc.git
cd qvac-lib-inference-embeddings-mlc/benchmarks/server

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
  "message": "Embeddings Addon Benchmark Server is running"
}
```

#### POST /run

Run inference with the GTE-Large model.

Sample request body:

```json
{
  "inputs": ["some-text-to-embed", "some-other-text-to-embed"], // array of text to embed
  "lib": "@tetherto/qvac-lib-inference-embeddings-mlc-bert-gte-large_335m-q4f16_1", // the library to use
  "version": "1.0.0", // the version of the library to use (optional)
  "params": {}, // Parameters for the addon (optional)
  "opts": {}, // Options for the addon (optional)
  "config": {} // Configuration for the addon (optional)
}
```

Sample response body:

```json
{
  "outputs": [[0.1, 0.2, 0.3], [0.4, 0.5, 0.6]],
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
