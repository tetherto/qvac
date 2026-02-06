"""
FastAPI server for Python native TTS implementation
"""

import os
from fastapi import FastAPI, HTTPException
from pydantic import BaseModel
from typing import List, Dict, Optional
import logging

from .tts_runner import PythonTTSRunner

# Lazy import for Chatterbox - only loaded when /synthesize-chatterbox is used
PythonChatterboxRunner = None


def _get_chatterbox_runner_class():
    """Lazily import PythonChatterboxRunner"""
    global PythonChatterboxRunner
    if PythonChatterboxRunner is None:
        from .chatterbox_runner import PythonChatterboxRunner as _PythonChatterboxRunner
        PythonChatterboxRunner = _PythonChatterboxRunner
    return PythonChatterboxRunner

# Configure logging
logging.basicConfig(
    level=logging.INFO,
    format='[%(asctime)s] [%(levelname)s] %(message)s',
    datefmt='%Y-%m-%d %H:%M:%S'
)
logger = logging.getLogger(__name__)

# Path to benchmarks directory (parent of python-server)
BENCHMARKS_DIR = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

app = FastAPI(
    title="TTS Python Native Benchmark Server",
    description="Baseline TTS implementation using piper-tts and chatterbox-tts for benchmarking",
    version="0.1.0"
)

# Global TTS runner instances
runner: Optional[PythonTTSRunner] = None
chatterbox_runner = None


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
            "/synthesize": "POST - Run Piper TTS synthesis",
            "/synthesize-chatterbox": "POST - Run Chatterbox TTS synthesis"
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

