"""Whisper transcription for round-trip audio quality testing"""

import logging
import tempfile
import wave
from pathlib import Path
from typing import Optional

import numpy as np
from faster_whisper import WhisperModel

logger = logging.getLogger(__name__)


class WhisperTranscriber:
    """Transcribe audio using Whisper for quality validation"""
    
    def __init__(self, model_size: str = "base", device: str = "cpu", compute_type: str = "int8", temperature: float = 0.0, language: str = "en"):
        """
        Initialize Whisper transcriber
        
        Args:
            model_size: Whisper model size (tiny, base, small, medium, large)
            device: Device to run on (cpu, cuda)
            compute_type: Compute type (int8, float16, float32)
            temperature: Temperature for sampling (0.0 for deterministic)
            language: Language code for transcription (e.g., "en", "es", "de", "it")
        """
        self.model_size = model_size
        self.device = device
        self.temperature = temperature
        self.compute_type = compute_type
        self.language = language
        self.model: Optional[WhisperModel] = None
        
    def load(self):
        """Load the Whisper model"""
        if self.model is not None:
            logger.info("Whisper model already loaded")
            return
            
        logger.info(f"Loading Whisper model: {self.model_size} on {self.device}")
        self.model = WhisperModel(
            self.model_size,
            device=self.device,
            compute_type=self.compute_type
        )
        logger.info("Whisper model loaded successfully")
        
    def transcribe_samples(self, samples: np.ndarray, sample_rate: int, language: Optional[str] = None) -> str:
        """
        Transcribe audio samples

        Args:
            samples: Audio samples as int16 numpy array
            sample_rate: Sample rate of audio
            language: Optional language code for this segment (overrides default)

        Returns:
            Transcribed text
        """
        if self.model is None:
            raise RuntimeError("Whisper model not loaded. Call load() first.")

        lang = language if language is not None else self.language

        # Create temporary WAV file
        with tempfile.NamedTemporaryFile(suffix=".wav", delete=False) as tmp_file:
            tmp_path = Path(tmp_file.name)

        try:
            # Write WAV file
            with wave.open(str(tmp_path), 'wb') as wav_file:
                wav_file.setnchannels(1)  # Mono
                wav_file.setsampwidth(2)  # 16-bit
                wav_file.setframerate(sample_rate)
                wav_file.writeframes(samples.tobytes())

            # Transcribe with deterministic settings
            segments, info = self.model.transcribe(
                str(tmp_path),
                language=lang,
                beam_size=1,  # Use 1 for deterministic decoding
                temperature=self.temperature,
                vad_filter=False,  # Don't filter silence, we want all audio
                best_of=1,  # Only generate 1 candidate for determinism
                patience=1.0  # Disable length penalty variations
            )
            
            # Combine all segments
            transcription = " ".join([segment.text.strip() for segment in segments])
            
            logger.debug(f"Transcribed: \"{transcription[:100]}...\"")
            
            return transcription.strip()
            
        finally:
            # Clean up temp file
            if tmp_path.exists():
                tmp_path.unlink()
                
    def close(self):
        """Clean up resources"""
        self.model = None

