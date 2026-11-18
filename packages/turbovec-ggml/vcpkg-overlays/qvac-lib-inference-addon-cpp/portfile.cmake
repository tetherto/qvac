# Overlay of the registry's qvac-lib-inference-addon-cpp port, pinned to the
# head of tetherto/qvac#5828, which adds JsAsyncTask::runOn and
# IAsyncTaskExecutor. Remove this overlay and require the inference-addon-cpp
# release that carries #5828 once it is in the registry.
vcpkg_from_git(
  OUT_SOURCE_PATH SOURCE_PATH
  URL https://github.com/tetherto/qvac.git
  REF 9e0ad5f5c27111e184e38f6c6d49fa861f49efbf
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
