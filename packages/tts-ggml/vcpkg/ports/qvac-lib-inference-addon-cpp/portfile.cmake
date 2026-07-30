# Dev overlay: build qvac-lib-inference-addon-cpp 1.3.3 from branch
# fix/addon-cpp-1.3.3-empty-cancel-retention (tetherto/qvac @ 38643638)
# instead of the published registry version, to verify this addon builds and
# passes against the 1.3.3 empty-cancel-snapshot retention fix (the iOS
# jetsam OOM found on this PR; see PR #3548 discussion). Backwards-
# compatibility check; same REF/SHA512 across every consumer addon on this
# branch. Bump REF/SHA512 (and the overlay port-version) when retargeting.
# To fall back to the registry version, remove this port directory and the
# "overlay-ports" entry in vcpkg-configuration.json.
vcpkg_from_github(
  OUT_SOURCE_PATH SOURCE_PATH
  REPO tetherto/qvac
  REF 386436380a5e74446754b4692112cee32cf76d17
  SHA512 1f47fb7475083bf61d01e914857dfa01d9f9181be0e68b0cf9dda2ef25f174463915435db157309bce324fa05f88bfa1cba6683f524c5017ee285df9e7254653
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
