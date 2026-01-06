#!/bin/bash

# Script to run Android app with proper environment setup

export JAVA_HOME=/opt/homebrew/opt/openjdk@21
export ANDROID_HOME=$HOME/Library/Android/sdk
export PATH=$PATH:$ANDROID_HOME/emulator:$ANDROID_HOME/platform-tools

cd "$(dirname "$0")"

echo "🔧 Environment:"
echo "  JAVA_HOME: $JAVA_HOME"
echo "  ANDROID_HOME: $ANDROID_HOME"
echo "  Node: $(which node)"
echo "  Java: $(java -version 2>&1 | head -1)"
echo ""

# Check if device is connected
if ! adb devices | grep -q "device$"; then
    echo "⚠️  No Android device detected!"
    echo "Please connect your phone via USB or start an emulator"
    exit 1
fi

echo "📱 Connected devices:"
adb devices
echo ""

# Run using the package.json script which handles all the setup
echo "🚀 Building and installing app using package.json android script..."
bun run android
