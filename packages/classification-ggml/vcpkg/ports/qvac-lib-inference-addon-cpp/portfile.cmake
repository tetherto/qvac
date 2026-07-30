# Dev overlay: build qvac-lib-inference-addon-cpp 1.3.3 from branch
# fix/addon-cpp-1.3.3-empty-cancel-retention (tetherto/qvac @ 2dcaa2e9)
# instead of the published registry version, to verify this addon builds and
# passes against the 1.3.3 cancel-retention fixes: the empty-snapshot skip
# plus releasing a JsAsyncTask's captures before its promise settles, which is
# what the real-cancel path needed (the iOS jetsam OOM found on this PR; see
# PR #3548 discussion). Backwards-
# compatibility check; same REF/SHA512 across every consumer addon on this
# branch. Bump REF/SHA512 (and the overlay port-version) when retargeting.
# To fall back to the registry version, remove this port directory and the
# "overlay-ports" entry in vcpkg-configuration.json.
vcpkg_from_github(
  OUT_SOURCE_PATH SOURCE_PATH
  REPO tetherto/qvac
  REF 2dcaa2e935796f1f31ab5182e2d514e0ecf701d6
  SHA512 ba27166042dc9c00ccae81d516630a3b35cb2bdb89c000604a56b6bb452abfe61221bbcb8b10d243a66dcdce42f9848083fce6f260d1c29905bcf00ccb05c7aa
  HEAD_REF main
)

vcpkg_check_features(
  OUT_FEATURE_OPTIONS FEATURE_OPTIONS
  FEATURES
    tests BUILD_TESTING
)

vcpkg_cmake_configure(
  SOURCE_PATH "${SOURCE_PATH}/packages/inference-addon-cpp"
  DISABLE_PARALLEL_CONFIGURE
  OPTIONS
    ${FEATURE_OPTIONS}
)

vcpkg_cmake_install()

file(REMOVE_RECURSE "${CURRENT_PACKAGES_DIR}/debug")

file(
  INSTALL "${SOURCE_PATH}/packages/inference-addon-cpp/LICENSE"
  DESTINATION "${CURRENT_PACKAGES_DIR}/share/${PORT}"
  RENAME copyright
)
