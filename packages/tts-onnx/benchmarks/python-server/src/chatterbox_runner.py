"""
Python Chatterbox TTS runner using chatterbox-tts

This provides a baseline implementation for comparison with the Node.js addon.
"""

import time
import logging
from pathlib import Path
from typing import List, Dict, Optional
import numpy as np

logger = logging.getLogger(__name__)

# Lazy import to avoid loading torch on startup if not needed
ChatterboxTTS = None


def _lazy_import_chatterbox():
    """Lazily import ChatterboxTTS to avoid loading torch unless needed"""
    global ChatterboxTTS
    if ChatterboxTTS is None:
        try:
            from chatterbox.tts import ChatterboxTTS as _ChatterboxTTS
            ChatterboxTTS = _ChatterboxTTS
            logger.info("Chatterbox TTS module loaded successfully")
        except ImportError as e:
            logger.error(f"Failed to import chatterbox-tts: {e}")
            logger.error("Install with: pip install chatterbox-tts")
            raise
    return ChatterboxTTS


def generate_synthetic_reference_audio(duration_sec: float = 1.0, sample_rate: int = 24000, frequency: float = 440.0) -> np.ndarray:
    """
    Generate synthetic reference audio for benchmarking.
    Creates a sine wave tone that can be used as reference audio when no real audio file is available.
    
    Args:
        duration_sec: Duration in seconds
        sample_rate: Sample rate (Chatterbox expects 24kHz)
        frequency: Frequency of sine wave in Hz (default A4 note)
    
    Returns:
        Audio samples as numpy array in range [-1, 1]
    """
    num_samples = int(sample_rate * duration_sec)
    t = np.arange(num_samples) / sample_rate
    # Generate sine wave with amplitude 0.5 to avoid clipping
    samples = np.sin(2 * np.pi * frequency * t) * 0.5
    return samples.astype(np.float32)


class PythonChatterboxRunner:
    """Chatterbox TTS runner using chatterbox-tts for benchmarking"""
    
    def __init__(self):
        self.model = None
        self.load_time_ms: float = 0
        self.current_device: Optional[str] = None
        self.reference_audio_path: Optional[str] = None
    
    def is_model_loaded(self) -> bool:
        """Check if the model is already loaded"""
        return self.model is not None
    
    def load_model(self, device: str = "cpu", reference_audio_path: str = None):
        """
        Load the Chatterbox TTS model
        
        Args:
            device: Device to run on ('cpu' or 'cuda')
            reference_audio_path: Path to reference audio file for voice cloning
        """
        load_start = time.perf_counter()
        
        # Lazy import
        _ChatterboxTTS = _lazy_import_chatterbox()
        
        logger.info(f"Loading Chatterbox model on device: {device}")
        
        # Load the model
        self.model = _ChatterboxTTS.from_pretrained(device=device)
        
        # Store reference audio path for use during synthesis
        self.reference_audio_path = reference_audio_path
        if reference_audio_path:
            logger.info(f"Using reference audio from: {reference_audio_path}")
        
        self.load_time_ms = (time.perf_counter() - load_start) * 1000
        self.current_device = device
        
        logger.info(f"Chatterbox model loaded in {self.load_time_ms:.2f}ms")
    
    def synthesize_batch(self, texts: List[str], include_samples: bool = False) -> Dict:
        """
        Synthesize multiple texts and return metrics
        
        Args:
            texts: List of text strings to synthesize
            include_samples: Whether to include audio samples in response
        
        Returns:
            Dictionary with outputs, timing, and metadata
        """
        if not self.model:
            raise RuntimeError("Model not loaded. Call load_model() first.")
        
        outputs = []
        gen_start = time.perf_counter()
        
        # Chatterbox uses 24kHz sample rate
        sample_rate = 24000
        
        for i, text in enumerate(texts):
            text_start = time.perf_counter()
            
            logger.debug(f"Synthesizing text {i+1}/{len(texts)}: \"{text[:50]}...\"")
            
            try:
                # Synthesize using Chatterbox
                # The model.generate returns a tensor with audio samples
                import torch
                
                with torch.no_grad():
                    # Generate audio - Chatterbox uses audio_prompt_path for voice cloning
                    if self.reference_audio_path:
                        audio_output = self.model.generate(text, audio_prompt_path=self.reference_audio_path)
                    else:
                        # Generate without reference audio (default voice)
                        audio_output = self.model.generate(text)
                    
                    # Convert to numpy
                    if isinstance(audio_output, torch.Tensor):
                        samples = audio_output.squeeze().cpu().numpy()
                    else:
                        samples = np.array(audio_output)
                    
                    # Ensure samples are float32 and normalized
                    if samples.dtype != np.float32:
                        samples = samples.astype(np.float32)
                    
                    # Normalize if needed (Chatterbox might return int16 range)
                    if np.abs(samples).max() > 1.0:
                        samples = samples / 32768.0
                
                text_gen_ms = (time.perf_counter() - text_start) * 1000
                
                sample_count = len(samples)
                duration_sec = sample_count / sample_rate
                rtf = (text_gen_ms / 1000) / duration_sec if duration_sec > 0 else 0
                
                logger.info(f"  Text: \"{text[:50]}\"")
                logger.info(f"  Samples: {sample_count}, Sample Rate: {sample_rate}")
                logger.info(f"  Duration: {duration_sec:.2f}s, Generation: {text_gen_ms:.2f}ms")
                logger.info(f"  RTF: {rtf:.4f} ({(1 / rtf) if rtf > 0 else 0:.1f}x real-time)")
                
                output = {
                    "text": text,
                    "sampleCount": sample_count,
                    "sampleRate": sample_rate,
                    "durationSec": duration_sec,
                    "generationMs": text_gen_ms,
                    "rtf": rtf
                }
                
                # Include samples if requested (for comparison)
                if include_samples:
                    # Convert to list for JSON serialization
                    output["samples"] = samples.tolist()
                
                outputs.append(output)
                
            except Exception as e:
                logger.error(f"Failed to synthesize text {i+1}: {e}")
                outputs.append({
                    "text": text,
                    "sampleCount": 0,
                    "sampleRate": sample_rate,
                    "durationSec": 0,
                    "generationMs": 0,
                    "rtf": 0,
                    "error": "Synthesis failed for this input",
                })
        
        total_gen_ms = (time.perf_counter() - gen_start) * 1000
        
        # Get chatterbox version
        try:
            import chatterbox
            version = f"chatterbox-{getattr(chatterbox, '__version__', 'unknown')}"
        except Exception:
            version = "chatterbox-unknown"
        
        return {
            "outputs": outputs,
            "implementation": "chatterbox-python",
            "version": version,
            "time": {
                "loadModelMs": self.load_time_ms,
                "totalGenerationMs": total_gen_ms
            }
        }
