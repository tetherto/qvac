"""
FastAPI server for Python native TTS implementation
"""

from fastapi import FastAPI, HTTPException
from pydantic import BaseModel
from typing import List, Dict, Optional
import logging

from .tts_runner import PythonTTSRunner

# Configure logging
logging.basicConfig(
    level=logging.INFO,
    format='[%(asctime)s] [%(levelname)s] %(message)s',
    datefmt='%Y-%m-%d %H:%M:%S'
)
logger = logging.getLogger(__name__)

app = FastAPI(
    title="TTS Python Native Benchmark Server",
    description="Baseline TTS implementation using piper-tts for benchmarking",
    version="0.1.0"
)

# Global TTS runner instance
runner: Optional[PythonTTSRunner] = None


class TTSConfig(BaseModel):
    modelPath: str
    configPath: str
    eSpeakDataPath: Optional[str] = None
    language: str = "en"
    sampleRate: int = 22050


class TTSRequest(BaseModel):
    texts: List[str]
    config: TTSConfig
    includeSamples: bool = False


@app.on_event("startup")
async def startup():
    """Initialize TTS runner on startup"""
    global runner
    runner = PythonTTSRunner()
    logger.info("TTS Python Native Server started")


@app.on_event("shutdown")
async def shutdown():
    """Cleanup on shutdown"""
    logger.info("TTS Python Native Server shutting down")


@app.get("/")
async def health():
    """Health check endpoint"""
    return {
        "message": "TTS Python Native Benchmark Server is running",
        "implementation": "python-native",
        "endpoints": {
            "/": "Health check",
            "/synthesize": "POST - Run TTS synthesis"
        }
    }


@app.post("/synthesize")
async def synthesize(request: TTSRequest):
    """
    Synthesize speech from text using piper-tts
    
    Returns metrics including RTF for benchmarking
    """
    global runner
    
    if not runner:
        raise HTTPException(500, "TTS runner not initialized")
    
    try:
        logger.info(f"Processing {len(request.texts)} texts")
        
        # Load model if not cached
        if not runner.is_model_loaded(request.config.modelPath, request.config.language):
            logger.info(f"Loading model: {request.config.modelPath}")
            runner.load_model(
                model_path=request.config.modelPath,
                config_path=request.config.configPath,
                espeak_data_path=request.config.eSpeakDataPath,
                language=request.config.language
            )
        else:
            logger.info("Using cached model")
        
        # Synthesize batch
        result = runner.synthesize_batch(
            texts=request.texts,
            sample_rate=request.config.sampleRate,
            include_samples=request.includeSamples
        )
        
        avg_rtf = sum(o["rtf"] for o in result["outputs"]) / len(result["outputs"])
        logger.info(f"Completed {len(result['outputs'])} syntheses in {result['time']['totalGenerationMs']:.2f}ms (avg RTF: {avg_rtf:.4f})")
        
        return result
        
    except FileNotFoundError as e:
        logger.error(f"File not found: {e}")
        raise HTTPException(404, f"Model or config file not found: {str(e)}")
    except Exception as e:
        logger.error(f"Synthesis failed: {e}", exc_info=True)
        raise HTTPException(500, f"Synthesis failed: {str(e)}")

