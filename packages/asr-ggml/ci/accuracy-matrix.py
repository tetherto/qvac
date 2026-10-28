#!/usr/bin/env python3
# asr's accuracy benchmark rows, as main's asr accuracy workflow generated its matrix: one row per model variant the
# dispatch's engine, language, dataset, model size or type asks for. Reads them from the environment.
import json
import os

engine = os.environ["ENGINE"]
language = os.environ["LANGUAGE"]
dataset = os.environ["DATASET"]
model_size = os.environ["MODEL_SIZE"]
model_type = os.environ["MODEL_TYPE"]
custom_model_repo = os.environ["CUSTOM_MODEL_REPO"]
max_samples = int(os.environ["MAX_SAMPLES"] or "-1")

whisper_lang_by_language = {
    "english": "",
    "french": "fr",
    "german": "de",
    "spanish": "es",
    "italian": "it",
    "portuguese": "pt",
    "mandarin_chinese": "zh",
    "arabic": "ar",
    "russian": "ru",
    "japanese": "ja",
    "czech": "cs",
}

include = []

if engine == "whisper":
    if custom_model_repo:
        include.append({
            "engine": "whisper",
            "model_variant": "custom",
            "model_file": "custom.bin",
            "quantization": "f16",
            "language": whisper_lang_by_language.get(language, ""),
            "source": "custom",
        })
    else:
        quant_configs = {
            "tiny": ["f16", "q5_1", "q8_0"],
            "base": ["f16", "q5_1", "q8_0"],
            "small": ["f16", "q5_1", "q8_0"],
            "medium": ["f16", "q5_0", "q8_0"],
        }

        for quant in quant_configs[model_size]:
            if quant == "f16":
                model_file = f"ggml-{model_size}.bin"
                variant = model_size
            else:
                model_file = f"ggml-{model_size}-{quant}.bin"
                variant = f"{model_size}-{quant}"

            include.append({
                "engine": "whisper",
                "model_variant": variant,
                "model_file": model_file,
                "quantization": quant,
                "language": "auto",
                "source": "huggingface",
            })

            if language == "english":
                if quant == "f16":
                    en_file = f"ggml-{model_size}.en.bin"
                    en_variant = f"{model_size}.en"
                else:
                    en_file = f"ggml-{model_size}.en-{quant}.bin"
                    en_variant = f"{model_size}.en-{quant}"

                include.append({
                    "engine": "whisper",
                    "model_variant": en_variant,
                    "model_file": en_file,
                    "quantization": quant,
                    "language": "en",
                    "source": "huggingface",
                })

        if model_size != "medium":
            futo_url = f"https://voiceinput.futo.org/VoiceInput/{model_size}_acft_q8_0.bin"
            include.append({
                "engine": "whisper",
                "model_variant": f"futo-{model_size}-acft-q8_0",
                "model_file": f"{model_size}_acft_q8_0.bin",
                "quantization": "acft-q8_0",
                "language": "auto",
                "source": "futo",
                "download_url": futo_url,
            })

            if language == "english":
                futo_en_url = f"https://voiceinput.futo.org/VoiceInput/{model_size}_en_acft_q8_0.bin"
                include.append({
                    "engine": "whisper",
                    "model_variant": f"futo-{model_size}.en-acft-q8_0",
                    "model_file": f"{model_size}_en_acft_q8_0.bin",
                    "quantization": "acft-q8_0",
                    "language": "en",
                    "source": "futo",
                    "download_url": futo_en_url,
                })
else:
    # Parakeet lanes: GGUF quants from the QVAC registry, staged from the model manifest;
    # f16 keeps the accuracy baseline comparable across model types.
    gguf_by_type = {
        "tdt": "parakeet-tdt-0.6b-v3.{quant}.gguf",
        "unified": "parakeet-unified-en-0.6b.{quant}.gguf",
        "ctc": "parakeet-ctc-0.6b.{quant}.gguf",
        "eou": "parakeet-eou-120m-v1.{quant}.gguf",
        "sortformer": "sortformer-4spk-v1.{quant}.gguf",
        "indic-conformer": "indic-conformer-ctc.{quant}.gguf",
    }

    model_types = [model_type] if model_type != "all" else ["tdt", "unified", "ctc", "eou", "sortformer", "indic-conformer"]

    def get_configs_for_type(mt):
        if mt == "indic-conformer":
            return [
                {"language": "hindi", "model_language": "hi", "dataset_type": "fleurs", "use_gpu": False, "streaming": False},
                {"language": "hindi", "model_language": "hi", "dataset_type": "fleurs", "use_gpu": True, "streaming": False},
                {"language": "gujarati", "model_language": "gu", "dataset_type": "fleurs", "use_gpu": False, "streaming": False},
                {"language": "gujarati", "model_language": "gu", "dataset_type": "fleurs", "use_gpu": True, "streaming": False},
                {"language": "kannada", "model_language": "kn", "dataset_type": "fleurs", "use_gpu": False, "streaming": False},
                {"language": "kannada", "model_language": "kn", "dataset_type": "fleurs", "use_gpu": True, "streaming": False},
                {"language": "tamil", "model_language": "ta", "dataset_type": "fleurs", "use_gpu": False, "streaming": False},
                {"language": "tamil", "model_language": "ta", "dataset_type": "fleurs", "use_gpu": True, "streaming": False},
            ]
        elif mt == "sortformer":
            return [
                {"language": "english", "dataset_type": "librispeech", "use_gpu": False, "streaming": False},
                {"language": "english", "dataset_type": "librispeech", "use_gpu": True, "streaming": False},
            ]
        elif mt == "eou":
            return [
                {"language": "english", "dataset_type": "librispeech", "use_gpu": False, "streaming": True},
                {"language": "english", "dataset_type": "librispeech", "use_gpu": True, "streaming": True},
                {"language": "english", "dataset_type": "librispeech", "use_gpu": False, "streaming": False},
            ]
        elif mt in ("ctc", "unified"):
            return [
                {"language": "english", "dataset_type": "librispeech", "use_gpu": False, "streaming": False},
                {"language": "english", "dataset_type": "librispeech", "use_gpu": True, "streaming": False},
                {"language": "english", "dataset_type": "librispeech", "use_gpu": False, "streaming": True},
            ]
        else:
            return [
                {"language": "english", "dataset_type": "librispeech", "use_gpu": False, "streaming": False},
                {"language": "english", "dataset_type": "librispeech", "use_gpu": True, "streaming": False},
                {"language": "english", "dataset_type": "librispeech", "use_gpu": False, "streaming": True},
                {"language": "french", "dataset_type": "fleurs", "use_gpu": False, "streaming": False},
                {"language": "german", "dataset_type": "fleurs", "use_gpu": False, "streaming": False},
                {"language": "spanish", "dataset_type": "fleurs", "use_gpu": False, "streaming": False},
            ]

    parakeet_max_samples = max_samples if max_samples != -1 else 50
    for mt in model_types:
        quant = "q8_0" if mt == "indic-conformer" else "f16"
        for cfg in get_configs_for_type(mt):
            mode_str = "streaming" if cfg["streaming"] else "batch"
            gpu_str = "gpu" if cfg["use_gpu"] else "cpu"
            variant = f"{mt}-{cfg['language']}-{cfg['dataset_type']}-{gpu_str}-{mode_str}"
            include.append({
                "engine": "parakeet",
                "model_variant": variant,
                "model_type": mt,
                "quant": quant,
                "gguf": gguf_by_type[mt].format(quant=quant),
                "use_gpu": cfg["use_gpu"],
                "language": cfg["language"],
                "model_language": cfg.get("model_language", ""),
                "dataset_type": cfg["dataset_type"],
                "streaming": cfg["streaming"],
                "max_samples": parakeet_max_samples,
            })

print(json.dumps(include))
