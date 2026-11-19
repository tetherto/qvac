#!/usr/bin/env node
// scripts/verify-prebuild-linking.mjs on one build leg's prebuilds, as main's per-platform prebuild job ran it: with
// BUILD_PLATFORM set, it checks that platform's and skips the rest. Usage: node ci/verify-linking.mjs <linux|win32>
process.env.BUILD_PLATFORM = process.argv[2]
process.argv.splice(2, 1, 'prebuilds')
await import('../scripts/verify-prebuild-linking.mjs')
