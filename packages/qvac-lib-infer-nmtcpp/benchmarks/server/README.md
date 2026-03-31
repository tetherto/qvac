# Marian Addon Benchmark Server

A JS server for benchmarking Marian translation addons, built with `bare` runtime.

## Features

- HTTP server using `bare-http1`
- Input validation using Zod
- Comprehensive error handling and logging
- Support for Marian translation addons
- Benchmarking capabilities for model performance

## Prerequisites

- `bare` runtime
- Marian translation addons

## Installation

```bash
# Clone the repository
git clone https://github.com/tetherto/qvac-lib-inference-addon-mlc-marian.git
cd qvac-lib-inference-addon-mlc-marian/benchmarks/server

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
  "message": "Marian Addon Benchmark Server is running"
}
```

#### POST /run

Run inference with the Marian model.

Sample request body:

```json
{
  "inputs": ["Hello", "World"], // array of input strings to translate
  "lib": "@qvac/translation-nmtcpp", // the library to use
  "version": "1.0.0", // the version of the library to use (optional)
  "link": "hyperdrive-link", // the hyperdrive link to the model files (optional)
  "params": {
    "mode": "full", // the mode to use
    "srcLang": "en", // the source language
    "dstLang": "it" // the target language
  },
  "opts": {}, // Options for the addon (optional)
  "config": {} // Config for the addon (optional)
}
```

Sample response body:

```json
{
  "outputs": ["Ciao", "Mondo"],
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
