"""
TTS Python Native Benchmark Server

This server provides a baseline Chatterbox TTS implementation
for comparison with the Node.js addon implementation.
"""

import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent / "src"))

from src.server import app
import uvicorn

if __name__ == "__main__":
    print("=" * 50)
    print("  TTS Python Native Benchmark Server")
    print("=" * 50)
    print("Starting server on http://localhost:8081")
    print("=" * 50)
    
    uvicorn.run(
        app,
        host="0.0.0.0",
        port=8081,
        log_level="info"
    )
