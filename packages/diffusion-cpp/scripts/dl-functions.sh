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
  [[ -f "$dest" ]] && echo "exists: $(basename "$dest")" && return
  echo "downloading: $(basename "$dest")"
  curl -fL --progress-bar --retry 5 --retry-delay 3 --retry-connrefused -C - -o "$dest" "$url" \
    || { rm -f "$dest"; exit 1; }
}
