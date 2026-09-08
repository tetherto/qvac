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
file_size() {
  if stat -f '%z' "$1" >/dev/null 2>&1; then
    stat -f '%z' "$1"
  else
    stat -c '%s' "$1"
  fi
}

dl() {
  local url="$1" dest="$2"

  [[ -f "$dest" ]] && echo "exists: $(basename "$dest")" && return
  echo "downloading: $(basename "$dest")"
  if [[ "$url" == https://huggingface.co/* && -n "${HF_TOKEN:-}" ]]; then
    curl -fL --progress-bar --retry 5 --retry-delay 3 --retry-connrefused -C - \
      -H "Authorization: Bearer $HF_TOKEN" -o "$dest" "$url" \
      || { rm -f "$dest"; exit 1; }
  else
    curl -fL --progress-bar --retry 5 --retry-delay 3 --retry-connrefused -C - -o "$dest" "$url" \
      || { rm -f "$dest"; exit 1; }
  fi
}
