#!/usr/bin/env bash
set -e

echo "Before cleanup — current clang path and version:"
which clang++
clang++ --version || true

echo "Checking for any Homebrew LLVM installations..."
for pkg in $(brew list --formula | grep '^llvm@' || true); do
  echo "Removing $pkg to prevent conflicts"
  brew uninstall --ignore-dependencies "$pkg" || true
done

echo "Cleaning up brew environment..."
brew cleanup -s || true
hash -r || true

echo "After cleanup — verifying Apple clang:"
which clang++
xcrun --find clang++
clang++ --version || true

if which clang++ | grep -q "/opt/homebrew/"; then
  echo "Still using Homebrew clang++ — aborting build!"
  exit 1
fi

echo "Homebrew LLVM removed successfully. Apple Clang is now active."
