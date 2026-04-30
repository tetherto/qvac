"""
Python Supertonic TTS runner using ONNX and Transformers tokenizer.

Based on the Hugging Face model card example:
https://huggingface.co/onnx-community/Supertonic-TTS-ONNX
"""

import os
import time
import logging
from pathlib import Path
from typing import List, Dict

import numpy as np

logger = logging.getLogger(__name__)

SupertonicTTS = None


def _lazy_import_supertonic():
    global SupertonicTTS
    if SupertonicTTS is None:
        try:
            import onnxruntime as ort
            from transformers import AutoTokenizer

            class _SupertonicTTS:
                SAMPLE_RATE = 44100
                CHUNK_COMPRESS_FACTOR = 6
                BASE_CHUNK_SIZE = 512
                LATENT_DIM = 24
                STYLE_DIM = 128
                LATENT_SIZE = BASE_CHUNK_SIZE * CHUNK_COMPRESS_FACTOR

                def __init__(self, model_path: str):
                    self.model_path = os.path.realpath(model_path)
                    if not os.path.isdir(self.model_path):
                        raise FileNotFoundError(
                            f"Supertonic model directory not found: {self.model_path}"
                        )
                    self.tokenizer = AutoTokenizer.from_pretrained(
                        self.model_path,
                        use_fast=False,
                    )
                    onnx_dir = os.path.join(self.model_path, "onnx")
                    for name in ("text_encoder.onnx", "latent_denoiser.onnx", "voice_decoder.onnx"):
                        p = os.path.join(onnx_dir, name)
                        if not os.path.isfile(p):
                            raise FileNotFoundError(
                                f"ONNX file not found: {p}. Run npm run setup:supertonic."
                            )
                    self.text_encoder = ort.InferenceSession(
                        os.path.join(onnx_dir, "text_encoder.onnx")
                    )
                    self.latent_denoiser = ort.InferenceSession(
                        os.path.join(onnx_dir, "latent_denoiser.onnx")
                    )
                    self.voice_decoder = ort.InferenceSession(
                        os.path.join(onnx_dir, "voice_decoder.onnx")
                    )

                def _load_style(self, voice: str) -> np.ndarray:
                    voice_path = os.path.join(
                        self.model_path, "voices", f"{voice}.bin"
                    )
                    if not os.path.exists(voice_path):
                        raise ValueError(f"Voice '{voice}' not found.")
                    style_vec = np.fromfile(voice_path, dtype=np.float32)
                    return style_vec.reshape(1, -1, self.STYLE_DIM)

                def generate(
                    self,
                    text: List[str],
                    *,
                    voice: str = "F1",
                    speed: float = 1.0,
                    steps: int = 5,
                ) -> List[np.ndarray]:
                    inputs = self.tokenizer(
                        text,
                        return_tensors="np",
                        padding=True,
                        truncation=True,
                    )
                    input_ids = inputs["input_ids"]
                    attn_mask = inputs["attention_mask"]
                    batch_size = input_ids.shape[0]

                    style = self._load_style(voice).repeat(batch_size, axis=0)

                    last_hidden_state, raw_durations = self.text_encoder.run(
                        None,
                        {
                            "input_ids": input_ids,
                            "attention_mask": attn_mask,
                            "style": style,
                        },
                    )
                    durations = (
                        raw_durations / speed * self.SAMPLE_RATE
                    ).astype(np.int64)

                    latent_lengths = (
                        durations + self.LATENT_SIZE - 1
                    ) // self.LATENT_SIZE
                    max_len = latent_lengths.max()
                    latent_mask = (
                        np.arange(max_len) < latent_lengths[:, None]
                    ).astype(np.int64)
                    latents = np.random.randn(
                        batch_size,
                        self.LATENT_DIM * self.CHUNK_COMPRESS_FACTOR,
                        max_len,
                    ).astype(np.float32)
                    latents *= latent_mask[:, None, :]

                    num_inference_steps = np.full(
                        batch_size, steps, dtype=np.float32
                    )
                    for step in range(steps):
                        timestep = np.full(
                            batch_size, step, dtype=np.float32
                        )
                        latents = self.latent_denoiser.run(
                            None,
                            {
                                "noisy_latents": latents,
                                "latent_mask": latent_mask,
                                "style": style,
                                "encoder_outputs": last_hidden_state,
                                "attention_mask": attn_mask,
                                "timestep": timestep,
                                "num_inference_steps": num_inference_steps,
                            },
                        )[0]

                    waveforms = self.voice_decoder.run(
                        None, {"latents": latents}
                    )[0]

                    results = []
                    for i, length in enumerate(
                        latent_mask.sum(axis=1) * self.LATENT_SIZE
                    ):
                        results.append(waveforms[i, :length])
                    return results

            SupertonicTTS = _SupertonicTTS
            logger.info("Supertonic TTS module loaded successfully")
        except ImportError as e:
            logger.error(f"Failed to import Supertonic dependencies: {e}")
            raise
    return SupertonicTTS


class PythonSupertonicRunner:
    """Supertonic TTS runner for benchmarking."""

    def __init__(self):
        self.model = None
        self.load_time_ms: float = 0
        self.voice_name: str = "F1"
        self.speed: float = 1.0
        self.steps: int = 5

    def is_model_loaded(self) -> bool:
        return self.model is not None

    def load_model(
        self,
        model_dir: str,
        voice_name: str = "F1",
        speed: float = 1.0,
        num_inference_steps: int = 5,
    ):
        load_start = time.perf_counter()
        _SupertonicTTS = _lazy_import_supertonic()
        logger.info(f"Loading Supertonic model from: {model_dir}")
        self.model = _SupertonicTTS(model_dir)
        self.voice_name = voice_name
        self.speed = speed
        self.steps = num_inference_steps
        self.load_time_ms = (time.perf_counter() - load_start) * 1000
        logger.info(f"Supertonic model loaded in {self.load_time_ms:.2f}ms")

    def synthesize_batch(
        self, texts: List[str], include_samples: bool = False
    ) -> Dict:
        if not self.model:
            raise RuntimeError("Model not loaded. Call load_model() first.")

        sample_rate = self.model.SAMPLE_RATE
        outputs = []
        gen_start = time.perf_counter()

        for i, text in enumerate(texts):
            text_start = time.perf_counter()
            try:
                audio_list = self.model.generate(
                    [text],
                    voice=self.voice_name,
                    speed=self.speed,
                    steps=self.steps,
                )
                samples = audio_list[0]
                if not isinstance(samples, np.ndarray):
                    samples = np.array(samples)
                if samples.dtype != np.float32:
                    samples = samples.astype(np.float32)

                text_gen_ms = (time.perf_counter() - text_start) * 1000
                sample_count = len(samples)
                duration_sec = sample_count / sample_rate
                rtf = (
                    (text_gen_ms / 1000) / duration_sec
                    if duration_sec > 0
                    else 0
                )

                logger.info(f"  Text: \"{text[:50]}\"")
                logger.info(
                    f"  Samples: {sample_count}, Sample Rate: {sample_rate}"
                )
                logger.info(
                    f"  Duration: {duration_sec:.2f}s, Generation: {text_gen_ms:.2f}ms"
                )
                logger.info(
                    f"  RTF: {rtf:.4f} ({(1 / rtf) if rtf > 0 else 0:.1f}x real-time)"
                )

                output = {
                    "text": text,
                    "sampleCount": sample_count,
                    "sampleRate": sample_rate,
                    "durationSec": duration_sec,
                    "generationMs": text_gen_ms,
                    "rtf": rtf,
                }
                if include_samples:
                    output["samples"] = samples.tolist()
                outputs.append(output)
            except Exception as e:
                logger.error(f"Failed to synthesize text {i + 1}: {e}")
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

        try:
            import transformers
            version = f"supertonic-python-transformers-{getattr(transformers, '__version__', 'unknown')}"
        except Exception:
            version = "supertonic-python-unknown"

        return {
            "outputs": outputs,
            "implementation": "supertonic-python",
            "version": version,
            "time": {
                "loadModelMs": self.load_time_ms,
                "totalGenerationMs": total_gen_ms,
            },
        }
