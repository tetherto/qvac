# Overlay (QVAC-21544): build qvac-lib-inference-addon-cpp 1.2.3 from the merged
# JsLogger teardown / re-setLogger crash fix (tetherto/qvac#2932, commit
# a3df3804) without moving the registry baseline (which would drag
# qvac-fabric/whisper/tts forward). Drop this overlay once the registry baseline
# this package pins already carries qvac-lib-inference-addon-cpp >= 1.2.3.
#
# Uses vcpkg_from_github (content-addressed tarball) rather than the registry
# port's vcpkg_from_git: the parallel per-platform prebuild jobs share the
# self-hosted runner's vcpkg downloads dir, and concurrent vcpkg_from_git clones
# collide on git-tmp/.git/shallow.lock. The tarball download is lock-free and
# deduplicated by SHA512.
vcpkg_from_github(
  OUT_SOURCE_PATH SOURCE_PATH
  REPO tetherto/qvac
  REF a3df3804b237a9e933b59d24a4dd26889b5c3395
  SHA512 ab2c985916b7b0ba5fe17b406ad4cde51b85dfe795eaec365339d35b45bf04c45cde4fa8624aadd7c7707d7e455e032633cd3b7720d68776cba3ab3e96868f96
)

vcpkg_check_features(
  OUT_FEATURE_OPTIONS FEATURE_OPTIONS
  FEATURES
    tests BUILD_TESTING
)

set(SOURCE_PATH "${SOURCE_PATH}/packages/inference-addon-cpp")

vcpkg_cmake_configure(
  SOURCE_PATH "${SOURCE_PATH}"
  DISABLE_PARALLEL_CONFIGURE
  OPTIONS
    ${FEATURE_OPTIONS}
)

vcpkg_cmake_install()

file(REMOVE_RECURSE "${CURRENT_PACKAGES_DIR}/debug")

file(
  INSTALL "${SOURCE_PATH}/LICENSE"
  DESTINATION "${CURRENT_PACKAGES_DIR}/share/${PORT}"
  RENAME copyright
)
