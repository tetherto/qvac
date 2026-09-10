#!/usr/bin/env bash
set -euo pipefail
# Public MiniMax-H3 downloader. Default: tested Unsloth FL2VA Q4.
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
provider=unsloth
args=()
while [[ $# -gt 0 ]]; do
  case "$1" in
    --provider) provider="$2"; shift 2 ;;
    -h|--help) echo "Usage: $(basename "$0") [--provider unsloth|realrebelai] [provider options]"; echo "Default: tested Unsloth FL2VA Q4. realrebelai requires --allow-unsupported-comfyui-layout."; exit 0 ;;
    *) args+=("$1"); shift ;;
  esac
done
case "$provider" in
  unsloth) exec "$SCRIPT_DIR/download-model-minimax-h3-unsloth.sh" "${args[@]}" ;;
  realrebelai) exec "$SCRIPT_DIR/download-model-minimax-h3-realrebelai-unsupported.sh" "${args[@]}" ;;
  *) echo "--provider must be unsloth or realrebelai" >&2; exit 2 ;;
esac
