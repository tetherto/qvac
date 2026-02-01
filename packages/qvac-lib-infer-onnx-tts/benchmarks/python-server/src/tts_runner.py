"""
Python TTS runner using piper-tts

This provides a baseline implementation for comparison with the Node.js addon.
"""

import os
import sys
import time
import logging
from pathlib import Path
from typing import List, Dict, Optional
import numpy as np

try:
    from piper import PiperVoice
except ImportError:
    print("ERROR: piper-tts not installed")
    print("Install with: pip install piper-tts")
    sys.exit(1)

logger = logging.getLogger(__name__)

# Path to shared eSpeak data
SHARED_DATA_DIR = Path(__file__).parent.parent.parent / "shared-data"
ESPEAK_DATA_PATH = SHARED_DATA_DIR / "espeak-ng-data"
MODELS_PATH = SHARED_DATA_DIR / "models"


def get_model_name_for_language(language: str) -> str:
    """
    Determine model name based on language
    
    Args:
        language: Language code (e.g., 'en-us', 'es', 'de', 'it', 'fr')
    
    Returns:
        Full model name for the language
    """
    lang = (language or "en-us").lower()
    
    model_map = {
        "en-us": "en_US-lessac-medium",
        "en": "en_US-lessac-medium",
        "es-es": "es_ES-davefx-medium",
        "es": "es_ES-davefx-medium",
        "de-de": "de_DE-thorsten-medium",
        "de": "de_DE-thorsten-medium",
        "it-it": "it_IT-paola-medium",
        "it": "it_IT-paola-medium",
        "fr-fr": "fr_FR-siwis-medium",
        "fr": "fr_FR-siwis-medium",
        "hi-in": "hi_IN-rohan-medium",
        "hi": "hi_IN-rohan-medium",
        "ar-jo": "ar_JO-kareem-medium",
        "ar": "ar_JO-kareem-medium",
        "bg-bg": "bg_BG-dimitar-medium",
        "bg": "bg_BG-dimitar-medium",
        "ca-es": "ca_ES-upc_ona-medium",
        "ca": "ca_ES-upc_ona-medium",
        "cs-cz": "cs_CZ-jirka-medium",
        "cs": "cs_CZ-jirka-medium",
        "cy-gb": "cy_GB-gwryw_gogleddol-medium",
        "cy": "cy_GB-gwryw_gogleddol-medium",
        "da-dk": "da_DK-talesyntese-medium",
        "da": "da_DK-talesyntese-medium",
        "el-gr": "el_GR-rapunzelina-medium",
        "el": "el_GR-rapunzelina-medium",
        "fa-ir": "fa_IR-reza_ibrahim-medium",
        "fa": "fa_IR-reza_ibrahim-medium",
        "fi-fi": "fi_FI-harri-medium",
        "fi": "fi_FI-harri-medium",
        "hu-hu": "hu_HU-imre-medium",
        "hu": "hu_HU-imre-medium",
        "id-id": "id_ID-news_tts-medium",
        "id": "id_ID-news_tts-medium",
        "is-is": "is_IS-ugla-medium",
        "is": "is_IS-ugla-medium",
        "ka-ge": "ka_GE-natia-medium",
        "ka": "ka_GE-natia-medium",
        "kk-kz": "kk_KZ-issai-high",
        "kk": "kk_KZ-issai-high",
        "lb-lu": "lb_LU-marylux-medium",
        "lb": "lb_LU-marylux-medium",
        "lv-lv": "lv_LV-aivars-medium",
        "lv": "lv_LV-aivars-medium",
        "ml-in": "ml_IN-meera-medium",
        "ml": "ml_IN-meera-medium",
        "ne-np": "ne_NP-chitwan-medium",
        "ne": "ne_NP-chitwan-medium",
        "nl-be": "nl_BE-nathalie-medium",
        "nl": "nl_BE-nathalie-medium",
        "nl-nl": "nl_NL-ronnie-medium",
        "nl": "nl_NL-ronnie-medium",
        "no-no": "no_NO-talesyntese-medium",
        "no": "no_NO-talesyntese-medium",
        "nb-no": "no_NO-talesyntese-medium",
        "nb": "no_NO-talesyntese-medium",
        "pl-pl": "pl_PL-gosia-medium",
        "pl": "pl_PL-gosia-medium",
        "pt-br": "pt_BR-jeff-medium",
        "pt": "pt_BR-jeff-medium",
        "pt-pt": "pt_PT-tugão-medium",
        "pt": "pt_PT-tugão-medium",
        "ro-ro": "ro_RO-mihai-medium",
        "ro": "ro_RO-mihai-medium",
        "ru-ru": "ru_RU-dmitri-medium",
        "ru": "ru_RU-dmitri-medium",
        "sk-sk": "sk_SK-lili-medium",
        "sk": "sk_SK-lili-medium",
        "sl-si": "sl_SI-artur-medium",
        "sl": "sl_SI-artur-medium",
        "sr-rs": "sr_RS-serbski_institut-medium",
        "sr": "sr_RS-serbski_institut-medium",
        "sv-se": "sv_SE-lisa-medium",
        "sv": "sv_SE-lisa-medium",
        "sw-cd": "sw_CD-lanfrica-medium",
        "sw": "sw_CD-lanfrica-medium",
        "te-in": "te_IN-padmavathi-medium",
        "te": "te_IN-padmavathi-medium",
        "tr-tr": "tr_TR-dfki-medium",
        "tr": "tr_TR-dfki-medium",
        "uk-ua": "uk_UA-ukrainian_tts-medium",
        "uk": "uk_UA-ukrainian_tts-medium",
        "vi-vn": "vi_VN-vais1000-medium",
        "vi": "vi_VN-vais1000-medium",
        "zh-cn": "zh_CN-huayan-medium",
        "zh": "zh_CN-huayan-medium",
        "cmn": "zh_CN-huayan-medium",
    }
    
    if lang in model_map:
        return model_map[lang]
    else:
        logger.warning(f"Unknown language '{language}', defaulting to English model")
        return "en_US-lessac-medium"


class PythonTTSRunner:
    """TTS runner using piper-tts for benchmarking"""
    
    def __init__(self):
        self.voice: Optional[PiperVoice] = None
        self.load_time_ms: float = 0
        self.current_model_path: Optional[str] = None
        self.current_language: Optional[str] = None
        
        # Set default eSpeak data directory
        if ESPEAK_DATA_PATH.exists():
            os.environ['ESPEAK_DATA_DIR'] = str(ESPEAK_DATA_PATH)
            logger.info(f"Using shared eSpeak data: {ESPEAK_DATA_PATH}")
        else:
            logger.warning(f"Shared eSpeak data not found at {ESPEAK_DATA_PATH}")
            logger.warning("Run setup.js first to download shared data!")
    
    def is_model_loaded(self, model_path: str, language: str) -> bool:
        """Check if the requested model is already loaded"""
        return (
            self.voice is not None and
            self.current_model_path == model_path and
            self.current_language == language
        )
    
    def load_model(
        self,
        model_path: str,
        config_path: str,
        espeak_data_path: Optional[str] = None,
        language: str = "en"
    ):
        """
        Load the TTS model
        
        Args:
            model_path: Path to ONNX model file
            config_path: Path to model config JSON
            espeak_data_path: Optional custom eSpeak data path
            language: Language code
        """
        load_start = time.perf_counter()
        
        # If using generic model paths, construct actual paths based on language
        model_name = get_model_name_for_language(language)
        
        # Check if we're using the generic paths and replace them with actual model names
        if model_path.endswith('model.onnx') or model_path.endswith('models/model.onnx'):
            # Get the benchmarks directory (3 levels up from this file)
            benchmarks_dir = Path(__file__).parent.parent.parent
            model_path = str(benchmarks_dir / "shared-data" / "models" / f"{model_name}.onnx")
            logger.info(f"Using model for language '{language}': {model_name}.onnx")
        
        if config_path.endswith('config.json') or config_path.endswith('models/config.json'):
            benchmarks_dir = Path(__file__).parent.parent.parent
            config_path = str(benchmarks_dir / "shared-data" / "models" / f"{model_name}.onnx.json")
            logger.info(f"Using config for language '{language}': {model_name}.onnx.json")
        
        # Override eSpeak data path if provided
        if espeak_data_path and Path(espeak_data_path).exists():
            os.environ['ESPEAK_DATA_DIR'] = espeak_data_path
            logger.info(f"Using custom eSpeak data: {espeak_data_path}")
        
        # Verify files exist
        if not Path(model_path).exists():
            raise FileNotFoundError(f"Model file not found: {model_path}")
        if not Path(config_path).exists():
            raise FileNotFoundError(f"Config file not found: {config_path}")
        
        # Load Piper voice
        logger.info(f"Loading Piper model: {model_path}")
        self.voice = PiperVoice.load(model_path, config_path)
        
        self.load_time_ms = (time.perf_counter() - load_start) * 1000
        self.current_model_path = model_path
        self.current_language = language
        
        logger.info(f"Model loaded in {self.load_time_ms:.2f}ms")
        logger.info(f"Model sample rate: {self.voice.config.sample_rate}")
    
    def synthesize_batch(self, texts: List[str], sample_rate: int = 22050, include_samples: bool = False) -> Dict:
        """
        Synthesize multiple texts and return metrics
        
        Args:
            texts: List of text strings to synthesize
            sample_rate: Audio sample rate (should match model)
        
        Returns:
            Dictionary with outputs, timing, and metadata
        """
        if not self.voice:
            raise RuntimeError("Model not loaded. Call load_model() first.")
        
        outputs = []
        gen_start = time.perf_counter()
        
        for i, text in enumerate(texts):
            text_start = time.perf_counter()
            
            logger.debug(f"Synthesizing text {i+1}/{len(texts)}: \"{text[:50]}...\"")
            
            # Synthesize - collect audio chunks
            audio_bytes = bytearray()
            for chunk in self.voice.synthesize(text):
                # Extract PCM data from AudioChunk
                if hasattr(chunk, "audio_int16_bytes"):
                    audio_bytes.extend(chunk.audio_int16_bytes)
                elif hasattr(chunk, "audio_float_array"):
                    # Convert float to int16
                    int16_data = (chunk.audio_float_array * 32767).astype(np.int16).tobytes()
                    audio_bytes.extend(int16_data)
            
            # Convert bytes to int16 array
            samples = np.frombuffer(bytes(audio_bytes), dtype=np.int16)
            
            text_gen_ms = (time.perf_counter() - text_start) * 1000
            
            sample_count = len(samples)
            # Use the model's actual sample rate, not the passed parameter
            actual_sample_rate = self.voice.config.sample_rate
            duration_sec = sample_count / actual_sample_rate
            rtf = (text_gen_ms / 1000) / duration_sec if duration_sec > 0 else 0
            
            logger.info(f"  Text: \"{text[:50]}\"")
            logger.info(f"  Samples: {sample_count}, Sample Rate: {actual_sample_rate}")
            logger.info(f"  Duration: {duration_sec:.2f}s, Generation: {text_gen_ms:.2f}ms")
            logger.info(f"  RTF: {rtf:.4f} ({(1 / rtf) if rtf > 0 else 0:.1f}x real-time)")
            logger.debug(f"  First 10 samples: {samples[:10].tolist()}")
            
            output = {
                "text": text,
                "sampleCount": sample_count,
                "sampleRate": actual_sample_rate,  # Return actual model sample rate
                "durationSec": duration_sec,
                "generationMs": text_gen_ms,
                "rtf": rtf
            }
            
            # Include samples if requested (for comparison)
            if include_samples:
                output["samples"] = samples.tolist()
            
            outputs.append(output)
        
        total_gen_ms = (time.perf_counter() - gen_start) * 1000
        
        # Get piper version
        version = "piper-1.2.0"  # Could get from package metadata
        
        return {
            "outputs": outputs,
            "implementation": "python-native",
            "version": version,
            "time": {
                "loadModelMs": self.load_time_ms,
                "totalGenerationMs": total_gen_ms
            }
        }

