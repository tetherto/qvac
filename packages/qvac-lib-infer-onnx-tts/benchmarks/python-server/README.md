# TTS Python Native Benchmark Server

Python server using `chatterbox-tts` for baseline TTS benchmarking.

## Prerequisites

- Python 3.8+
- Shared data downloaded (run `npm run setup` in ../server/)

## Installation

```bash
pip install -r requirements.txt
pip install -r requirements-chatterbox.txt
```

## Usage

```bash
python main.py  # Starts on port 8081
```

Or with uvicorn:
```bash
uvicorn main:app --host 0.0.0.0 --port 8081
```

## API Endpoints

### GET /

Health check.

Response:
```json
{
  "message": "TTS Python Native Benchmark Server is running",
  "implementation": "python-native"
}
```

### POST /synthesize-chatterbox

Run Chatterbox TTS synthesis.

Request and response format identical to addon server for fair comparison.

Response:
```json
{
  "outputs": [
    {
      "text": "Hello world",
      "sampleCount": 33075,
      "sampleRate": 24000,
      "durationSec": 1.5,
      "generationMs": 18.2,
      "rtf": 0.082
    }
  ],
  "implementation": "python-native",
  "version": "chatterbox-0.1.0",
  "time": {
    "loadModelMs": 312.7,
    "totalGenerationMs": 18.2
  }
}
```

## Model Caching

The server caches loaded models in memory.
