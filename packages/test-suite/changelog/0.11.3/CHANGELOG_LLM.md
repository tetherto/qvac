# QVAC Test Suite v0.11.3 Release Notes

📦 **NPM:** https://www.npmjs.com/package/@qvac/test-suite/v/0.11.3

Mobile consumer builds are fixed. Building for one platform no longer fails on the other platform's binaries, and split native addons now arrive with the binary they need instead of silently shipping without it.

---

## Bug Fixes

### Mobile builds only look at the platform being built

`withMobileBundle` passed the combined Android and iOS host list to both the bundler and the verifier, so an Android prebuild failed when iOS binaries were absent, and an iOS prebuild failed the same way in reverse. Each step now selects the hosts for the platform it is building: `android-arm64` for Android, and `ios-arm64` plus the two simulator hosts for iOS.

Only verification is scoped this way. The worker bundle is a single artifact both platforms import, so it is still built for every mobile host — building it per platform made a dual-platform `expo prebuild` overwrite the first platform's bundle with the second's.

### Split native addons ship their binary again

Mobile consumer manifests declared only the meta addon packages, which ship JavaScript and no binaries. Since those addons were split per platform, the actual binaries live in cross-built packages that no install host ever matches, so neither `os`/`cpu`-filtered `optionalDependencies` nor the package manager running on the build host could ever select them. Every mobile consumer therefore installed the addon without its binary and failed bundle verification.

The generator now reads the installed tree for packages that route their native binding through a `#host-addon` imports map, resolves the package that map names for the platform being built, and declares it directly — an Android build gets `@qvac/<addon>-android-arm64`, an iOS build gets `@qvac/<addon>-ios`, and neither downloads the other's binaries. Reading each addon's own imports map rather than a hardcoded roster keeps the selection in step with the publish-time slicer and skips pre-split versions, which carry no such map. The addon and its prebuild package are pinned to the same exact version.

A related gap closed with it: `bare-link` emits a binary only for a package marked `addon: true` and reads it from that package's own `prebuilds/` directory. After the split, the meta package kept the marker but shipped no prebuilds, so verification passed while the linker emitted nothing and a clean build shipped no native addon at all. The linker now resolves each addon's platform package through the same imports map and links that directory directly, keeping the emitted library's pre-split name.

Three cases are deliberately left untouched: an addon the consumer pins itself — to a range, a `file:` path, or a different version — an addon that already ships a local `prebuilds/` directory for the target, and a pre-split addon version. Source builds keep taking precedence.
