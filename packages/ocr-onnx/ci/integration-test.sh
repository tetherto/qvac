#!/usr/bin/env bash
set -euo pipefail

# Check that ./models exists
if [ ! -d "models" ]; then
  echo "Error: directory 'models/' not found in $(pwd). models files can be downloaded from https://drive.google.com/drive/u/3/folders/1vmN-1Olm1c8ZHm5m6ThHM5TdWzwuYIU5" >&2
  exit 1
fi

# Check that ./models/ocr exists
if [ ! -d "models/ocr" ]; then
  echo "Error: directory 'models/ocr/' not found in $(pwd)" >&2
  exit 1
fi

# Check for at least one .onnx under models/ocr
shopt -s nullglob
onnx_files=( models/ocr/*.onnx )
shopt -u nullglob

if [ ${#onnx_files[@]} -eq 0 ]; then
  echo "Error: no .onnx files found in models/ocr/ in $(pwd)" >&2
  exit 1
fi

# Setup vcpkg
git clone https://github.com/microsoft/vcpkg.git
cd vcpkg
./bootstrap-vcpkg.sh
export VCPKG_ROOT="$PWD"
cd ..

# Setup OCR addon
git clone git@github.com:tetherto/qvac-lib-inference-addon-onnx-ocr-fasttext.git
cd qvac-lib-inference-addon-onnx-ocr-fasttext/
npm install -g bare bare-make
npm install

# Build addon
bare-make generate
bare-make build
bare-make install

# Run integration tests
ln -s ../models
npm run test:integration
