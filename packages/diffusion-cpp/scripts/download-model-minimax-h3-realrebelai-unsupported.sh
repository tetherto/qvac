#!/usr/bin/env bash
set -euo pipefail

# Download MiniMax-H3 GGUF components published by realrebelai.
#
# EXPERIMENTAL: these realrebelai GGUFs use a ComfyUI-specific H3 tensor
# layout and are not currently loadable by stable-diffusion.cpp. The script is
# retained for explicit download/interoperability experiments only.
#
# Default: FL2VA Q3 + Q2 encoder. This is the prompt-to-video pairing that
# fits a 32 GB GPU when used with text-encoder CPU placement/offloading.
#
# Usage:
#   ./scripts/download-model-minimax-h3-realrebelai.sh
#   ./scripts/download-model-minimax-h3-realrebelai.sh --variant ref2va --quant q4
#   MODELS_DIR=/models/h3 ./scripts/download-model-minimax-h3-realrebelai.sh

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
MODELS_DIR="${MODELS_DIR:-$ROOT_DIR/models/minimax-h3-realrebelai}"
VARIANT="fl2va"
QUANT="q3"
ALLOW_UNSUPPORTED_COMFYUI_LAYOUT=false
HF_REVISION="${HF_REVISION:-main}"
GGUF_REPO="realrebelai/MiniMax-H3_GGUFs"
LLM_REPO="unsloth/MiniMax-H3-GGUF"
VAE_REPO="Comfy-Org/MiniMax-H3"

usage() {
    cat <<EOF
Usage: $(basename "$0") --allow-unsupported-comfyui-layout [--variant fl2va|ref2va] [--quant q3|q4] [--models-dir DIR]

Downloads realrebelai MiniMax-H3 GGUFs for an explicitly unsupported ComfyUI
layout. These files do not currently run in stable-diffusion.cpp.

Environment:
  MODELS_DIR    destination directory
  HF_REVISION   Hugging Face revision (default: main)
  HF_TOKEN      optional Hugging Face token
EOF
}

while [[ $# -gt 0 ]]; do
    case "$1" in
        --variant)
            VARIANT="$2"
            shift 2
            ;;
        --quant)
            QUANT="$2"
            shift 2
            ;;
        --models-dir)
            MODELS_DIR="$2"
            shift 2
            ;;
        --allow-unsupported-comfyui-layout)
            ALLOW_UNSUPPORTED_COMFYUI_LAYOUT=true
            shift
            ;;
        -h|--help)
            usage
            exit 0
            ;;
        *)
            echo "Unknown option: $1" >&2
            usage >&2
            exit 2
            ;;
    esac
done

if [[ "$ALLOW_UNSUPPORTED_COMFYUI_LAYOUT" != true ]]; then
    echo "realrebelai MiniMax-H3 GGUFs are currently incompatible with stable-diffusion.cpp." >&2
    echo "Pass --allow-unsupported-comfyui-layout only to download them for external experiments." >&2
    exit 2
fi

case "$VARIANT" in
    fl2va) DENOISER_PREFIX="MiniMax-H3-FL2VA" ;;
    ref2va) DENOISER_PREFIX="MiniMax-H3-REF2VA" ;;
    *)
        echo "--variant must be fl2va or ref2va (got: $VARIANT)" >&2
        exit 2
        ;;
esac

case "$QUANT" in
    q3)
        DENOISER_FILE="$DENOISER_PREFIX-Q3_K_M.gguf"
        DENOISER_SIZE=15577923360
        LLM_FILE="qwen3vl_32b_minimax_h3-Q2_K_M.gguf"
        LLM_SIZE=13102161024
        ;;
    q4)
        DENOISER_FILE="$DENOISER_PREFIX-Q4_K_M.gguf"
        DENOISER_SIZE=19864208160
        LLM_FILE="qwen3vl_32b_minimax_h3-Q4_K_M.gguf"
        LLM_SIZE=18218065024
        ;;
    *)
        echo "--quant must be q3 or q4 (got: $QUANT)" >&2
        exit 2
        ;;
esac

file_size() {
    if stat -f '%z' "$1" >/dev/null 2>&1; then
        stat -f '%z' "$1"
    else
        stat -c '%s' "$1"
    fi
}

download_verified() {
    local repo="$1"
    local relative_path="$2"
    local expected_size="$3"
    local destination="$MODELS_DIR/$relative_path"
    local partial="$destination.partial"
    local url="https://huggingface.co/$repo/resolve/$HF_REVISION/$relative_path"

    mkdir -p "$(dirname "$destination")"
    if [[ -f "$destination" ]] && [[ "$(file_size "$destination")" == "$expected_size" ]]; then
        echo "verified: $relative_path"
        return
    fi

    rm -f "$destination"
    echo "downloading: $relative_path"
    if [[ -n "${HF_TOKEN:-}" ]]; then
        curl -fL --progress-bar --retry 5 --retry-delay 3 --retry-connrefused -C - \
            -H "Authorization: Bearer $HF_TOKEN" -o "$partial" "$url"
    else
        curl -fL --progress-bar --retry 5 --retry-delay 3 --retry-connrefused -C - \
            -o "$partial" "$url"
    fi

    if [[ "$(file_size "$partial")" != "$expected_size" ]]; then
        echo "size verification failed for $relative_path" >&2
        rm -f "$partial"
        exit 1
    fi
    mv "$partial" "$destination"
    echo "verified: $relative_path"
}

download_verified "$GGUF_REPO" "$DENOISER_FILE" "$DENOISER_SIZE"
download_verified "$LLM_REPO" "$LLM_FILE" "$LLM_SIZE"
download_verified "$VAE_REPO" "vae/minimax_h3_video_vae_fp16.safetensors" 5207808496
download_verified "$VAE_REPO" "vae/minimax_h3_audio_vae_fp32.safetensors" 605254808

cat <<EOF

MiniMax-H3 $VARIANT $QUANT model set is ready in: $MODELS_DIR

Example:
  sd-cli --mode vid_gen \\
    --diffusion-model "$MODELS_DIR/$DENOISER_FILE" \\
    --llm "$MODELS_DIR/$LLM_FILE" \\
    --vae "$MODELS_DIR/vae/minimax_h3_video_vae_fp16.safetensors" \\
    --audio-vae "$MODELS_DIR/vae/minimax_h3_audio_vae_fp32.safetensors" \\
    --prompt "A realistic cinematic coffee advertisement" \\
    --width 960 --height 544 --video-frames 124 --steps 8 \\
    --cfg-scale 1.0 --guidance 7.0 --backend te=cpu --diffusion-fa \\
    --offload-to-cpu --output output.webm
EOF
