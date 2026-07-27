#!/usr/bin/env bash
# Shared download utility functions for model scripts

# dl — Download a file with retry logic and resume capability
#
# Usage: dl <url> <destination>
#
# Features:
#   - Skips if file already exists
#   - Retries on transient errors (up to 5 times)
#   - Resumes partial downloads
#   - Shows progress bar
#   - Cleans up on failure
#
# Example:
#   dl "https://huggingface.co/example/file.safetensors" "./models/file.safetensors"
#
dl() {
  local url="$1" dest="$2"
  local -a auth_args=()

  [[ -f "$dest" ]] && echo "exists: $(basename "$dest")" && return
  if [[ "$url" == https://huggingface.co/* && -n "${HF_TOKEN:-}" ]]; then
    auth_args=(-H "Authorization: Bearer $HF_TOKEN")
  fi
  echo "downloading: $(basename "$dest")"
  curl -fL --progress-bar --retry 5 --retry-delay 3 --retry-connrefused -C - "${auth_args[@]}" -o "$dest" "$url" \
    || { rm -f "$dest"; exit 1; }
}
