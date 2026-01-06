#!/bin/bash

echo "📱 Uninstalling old app from device..."
adb uninstall io.tether.qvac_test_consumer_mobile 2>/dev/null || echo "   (app not installed)"

echo ""
echo "🧹 Cleaning build artifacts..."
rm -rf .expo node_modules/.cache android/app/build

echo "🔄 Prebuilding..."
bun x expo prebuild --platform android --clean --no-install


echo ""
echo "🚀 Rebuilding and installing..."
bun run android

