# Dev overlay: build qvac-lib-inference-addon-cpp 1.3.2 from PR #3564
# (tetherto/qvac @ fe64ee07) instead of the published registry version.
# This isolates the JsAsyncTask release-before-settlement fix in diffusion-cpp
# while collecting iOS unload telemetry. To fall back to the registry version,
# remove this port directory and the "overlay-ports" configuration entry.
vcpkg_from_github(
  OUT_SOURCE_PATH SOURCE_PATH
  REPO tetherto/qvac
  REF fe64ee074d002c907092816df6cdff2945bd9097
  SHA512 de0ff119c8509c75f5623eca1ef43bb6c513e11e6bc9941c8eccc73a1ff3dc12dd6c97737adc977e4635dea5c39f958b56bf75801b03227f69f498dbef2f78dc
  HEAD_REF tmp-addon-cpp-pr-3564-fix
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
