"""
FastAPI server for Python native TTS implementation
"""

import os
from fastapi import FastAPI, HTTPException
from pydantic import BaseModel
from typing import List, Dict, Optional
import logging

PythonChatterboxRunner = None

def _get_chatterbox_runner_class():
    """Lazily import PythonChatterboxRunner"""
    global PythonChatterboxRunner
    if PythonChatterboxRunner is None:
        from .chatterbox_runner import PythonChatterboxRunner as _PythonChatterboxRunner
        PythonChatterboxRunner = _PythonChatterboxRunner
    return PythonChatterboxRunner

logging.basicConfig(
    level=logging.INFO,
    format='[%(asctime)s] [%(levelname)s] %(message)s',
    datefmt='%Y-%m-%d %H:%M:%S'
)
logger = logging.getLogger(__name__)

BENCHMARKS_DIR = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

app = FastAPI(
    title="TTS Python Native Benchmark Server",
    description="Baseline TTS implementation using chatterbox-tts for benchmarking",
    version="0.1.0"
)

chatterbox_runner = None


class ChatterboxConfig(BaseModel):
    modelDir: Optional[str] = None
    referenceAudioPath: Optional[str] = None
    language: str = "en"
    sampleRate: int = 24000
    useGPU: bool = False
    variant: str = "fp32"


class ChatterboxRequest(BaseModel):
    texts: List[str]
    config: ChatterboxConfig
    includeSamples: bool = False


@app.on_event("startup")
async def startup():
    """Initialize server - runners are lazy loaded on first request"""
    logger.info("TTS Python Native Server started")
    logger.info("Runners will be initialized on first request")


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
            "/synthesize-chatterbox": "POST - Run Chatterbox TTS synthesis"
        }
    }


@app.post("/synthesize-chatterbox")
async def synthesize_chatterbox(request: ChatterboxRequest):
    """
    Synthesize speech from text using chatterbox-tts
    
    Returns metrics including RTF for benchmarking
    """
    global chatterbox_runner
    
    if not chatterbox_runner:
        try:
            RunnerClass = _get_chatterbox_runner_class()
            chatterbox_runner = RunnerClass()
            logger.info("Chatterbox runner initialized")
        except ImportError as e:
            logger.error(f"Failed to initialize Chatterbox runner: {e}")
            raise HTTPException(500, f"chatterbox-tts not installed: {str(e)}")
    
    try:
        logger.info(f"[Chatterbox] Processing {len(request.texts)} texts")
        
        device = "cuda" if request.config.useGPU else "cpu"
        
        if not chatterbox_runner.is_model_loaded():
            ref_audio_path = request.config.referenceAudioPath
            if ref_audio_path and not os.path.isabs(ref_audio_path):
                ref_audio_path = os.path.join(BENCHMARKS_DIR, ref_audio_path)
            
            logger.info(f"[Chatterbox] Loading model on device: {device}")
            chatterbox_runner.load_model(
                device=device,
                reference_audio_path=ref_audio_path
            )
        else:
            logger.info("[Chatterbox] Using cached model")
        
        result = chatterbox_runner.synthesize_batch(
            texts=request.texts,
            include_samples=request.includeSamples
        )
        
        valid_outputs = [o for o in result["outputs"] if o.get("rtf", 0) > 0]
        if valid_outputs:
            avg_rtf = sum(o["rtf"] for o in valid_outputs) / len(valid_outputs)
            logger.info(f"[Chatterbox] Completed {len(result['outputs'])} syntheses in {result['time']['totalGenerationMs']:.2f}ms (avg RTF: {avg_rtf:.4f})")
        else:
            logger.warning("[Chatterbox] No valid outputs to calculate average RTF")
        
        return result
        
    except ImportError as e:
        logger.error(f"[Chatterbox] Import error: {e}")
        raise HTTPException(500, f"Chatterbox not installed: {str(e)}")
    except Exception as e:
        logger.error(f"[Chatterbox] Synthesis failed: {e}", exc_info=True)
        raise HTTPException(500, f"Chatterbox synthesis failed: {str(e)}")
