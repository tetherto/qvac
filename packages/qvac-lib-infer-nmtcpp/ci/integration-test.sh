#!/bin/bash

# Guide:
# https://github.com/tetherto/ai-runtime-docs/blob/main/Components/Inference/Packages/qvac-lib-infer-nmtcpp.md

# echo """Script assumes:
# - you have setup access to Private NPM registry.
# - you have gh cli, jq, node, npm, git installed.
# - you have logged in to gh cli. """

# Create temp directory for GPG home
export REPO_DIR=$(mktemp -d -t marian_$(date +%Y.%m.%d)-XXXX)
echo "Using temp directory: $REPO_DIR"

# Clone the repository
git clone https://github.com/tetherto/qvac-lib-infer-nmtcpp.git $REPO_DIR

# Navigate to the project directory:
cd $REPO_DIR

echo "Expected you run it from freshly cloned Marian repo"

# Initialize submodules:
git submodule update --init --recursive

# Install npm dependencies:
npm install -g bare bare-make
npm install

# There is a native addon that interfaces with the Marian model. To build the addon:
npx bare-make generate
npx bare-make build
npx bare-make install
npm run test:unit

# Print run state
echo "node version: $(node -v)"
echo "npm version: $(npm -v)"
echo "bare version: $(bare -v)"
echo "bare-make version: $(bare-make --version)"

# Download tar with compiled model weights https://github.com/tetherto/qvac-ext-lib-mlc/actions/runs/14471889649
gh run download 14471889649 -R tetherto/qvac-ext-lib-mlc -n output-q4f16_1-opus-mt-en-it --dir model/marian/vulkan/en-it/

# Download compiled model library https://github.com/tetherto/qvac-ext-lib-mlc/actions/runs/14752087140
if [[ "$(uname -s)" == "Darwin" ]]; then
    echo "macOS"; gh run download 14752087140 -R tetherto/qvac-ext-lib-mlc -n darwin-arm64
    mv opus-q4f16_1.so model/marian/vulkan/en-it/opus-mt-en-it.so
elif [[ "$(uname -s)" == "Linux" ]]; then
    echo "Linux"; gh run download 14752087140 -R tetherto/qvac-ext-lib-mlc -n linux-x64
    mv opus-q4f16_1.so model/marian/vulkan/en-it/opus-mt-en-it.so
elif [[ "$(uname -s)" == MINGW* || "$(uname -s)" == MSYS* || "$(uname -s)" == CYGWIN* ]]; then
    echo "Windows"; gh run download 14752087140 -R tetherto/qvac-ext-lib-mlc -n win32-x64
    mv opus-q4f16_1.so model/marian/vulkan/en-it/opus-mt-en-it.so
else
    echo "Skipping .so update, OS: $(uname -s)" 
fi

# Run quickstart example with deps installed
npm install "@qvac/translation-nmtcpp@"$(npm ls --json | jq -r '.version')
npx bare examples/quickstart.js

# Run integration test
npm run test:integration
