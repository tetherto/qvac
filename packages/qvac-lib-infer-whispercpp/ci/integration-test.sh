#!/bin/bash

# Guide:
# https://github.com/tetherto/ai-runtime-docs/blob/main/Components/Inference/Packages/qvac-lib-infer-whispercpp.md

# echo """Script assumes:
# - you have setup access to Private NPM registry.
# - you have gh cli, jq, node, npm, git installed.
# - you have logged in to gh cli. """

# Create temp directory
export REPO_DIR="./integration_test_$(date +%Y.%m.%d_%H%M%S)"
mkdir -p $REPO_DIR
echo "Using temp directory: $REPO_DIR"

# Clone the repository
git clone https://github.com/tetherto/qvac-lib-infer-whispercpp $REPO_DIR

# Navigate to the project directory:
cd $REPO_DIR

echo "Expected you run it from freshly cloned Whisper repo"

# Initialize submodules:
git submodule update --init --recursive

# Install npm dependencies:
npm install -g bare bare-make
npm install

# There is a native addon that interfaces with the Whisper model. To build the addon:
npx bare-make generate
npx bare-make build
npx bare-make install
npm run test:unit

# Print run state
echo "node version: $(node -v)"
echo "npm version: $(npm -v)"
echo "bare version: $(bare -v)"
echo "bare-make version: $(bare-make --version)"


# if [[ "$(uname -s)" == "Darwin" ]]; then
#     PLATFORM="darwin-arm64"
# elif [[ "$(uname -s)" == "Linux" ]]; then
#     PLATFORM="linux-x64"
# elif [[ "$(uname -s)" == MINGW* || "$(uname -s)" == MSYS* || "$(uname -s)" == CYGWIN* ]]; then
#     PLATFORM="win32-x64"
# fi

# Run integration test
npm run test:integration

# Run quickstart example with deps installed
npm install "@qvac/transcription-whispercpp"
echo "if it will fail and hang, try to cd and run it again - worked for me, investigating"
npx bare example/quickstart.js

