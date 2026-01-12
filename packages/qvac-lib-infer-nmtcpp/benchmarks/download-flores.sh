#!/bin/bash
#
# Download FLORES-200 devtest dataset for evaluation
# (Same dataset used by evaluate.py)
#

set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
DEST_DIR="${1:-$SCRIPT_DIR/flores200_dataset}"

echo "Downloading FLORES-200 dataset to: $DEST_DIR"

# Create destination directory
mkdir -p "$DEST_DIR"
cd "$DEST_DIR"

# Download FLORES-200 from GitHub release
FLORES_URL="https://tinyurl.com/flores200dataset"

echo "Downloading from: $FLORES_URL"

if command -v wget &> /dev/null; then
  wget --no-check-certificate -q --show-progress "$FLORES_URL" -O flores200.tar.gz
elif command -v curl &> /dev/null; then
  curl -L -k -# "$FLORES_URL" -o flores200.tar.gz
else
  echo "Error: wget or curl required"
  exit 1
fi

# Check file size
FILE_SIZE=$(stat -c%s flores200.tar.gz 2>/dev/null || stat -f%z flores200.tar.gz 2>/dev/null || echo "0")
echo "Downloaded file size: $FILE_SIZE bytes"

if [ "$FILE_SIZE" -lt 1000000 ]; then
  echo "Warning: File seems too small. Trying alternative URL..."
  
  # Alternative: direct Facebook URL
  ALT_URL="https://dl.fbaipublicfiles.com/flores200/flores200_dataset.tar.gz"
  echo "Trying: $ALT_URL"
  
  if command -v wget &> /dev/null; then
    wget --no-check-certificate -q --show-progress "$ALT_URL" -O flores200.tar.gz
  else
    curl -L -k -# "$ALT_URL" -o flores200.tar.gz
  fi
fi

# Extract
echo "Extracting..."
tar -xzf flores200.tar.gz

# Check what was extracted
if [ -d "flores200_dataset" ]; then
  mv flores200_dataset/* . 2>/dev/null || true
  rm -rf flores200_dataset
fi

# Clean up
rm -f flores200.tar.gz

# Verify
if [ -d "devtest" ] && [ -f "devtest/eng_Latn.devtest" ]; then
  echo "✓ FLORES-200 dataset downloaded successfully!"
  echo ""
  echo "Sample files:"
  ls devtest/ | grep -E "eng_Latn|ita_Latn" | head -5
  echo ""
  echo "Total files in devtest:"
  ls devtest/ | wc -l
else
  echo "❌ Download failed or wrong format"
  echo "Contents:"
  ls -la
  exit 1
fi
