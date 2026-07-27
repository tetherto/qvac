# Dev overlay: build qvac-lib-inference-addon-cpp 1.3.1 from the addon-cpp
# snapshot branch (tetherto/qvac @ continuousBatchingMultiJobAddonCppFixup) instead
# of the published registry version, to verify this addon builds unchanged
# against the 1.3.1 multi-job scheduler (backwards-compatibility check; same
# REF/SHA512 as the llm-llamacpp portfile_dev overlay). Bump REF/SHA512 (and
# the overlay port-version) when that branch moves. To fall back to the
# registry version, remove this port directory and the "overlay-ports" entry
# in vcpkg-configuration.json.
vcpkg_from_github(
  OUT_SOURCE_PATH SOURCE_PATH
  REPO tetherto/qvac
  REF ae77dd7a949cf09aee99fc149260f52f3a4c9265
  SHA512 7f0f119b62212c15c462ce8ea123571fa6943a13f71b00d92a3331d6e2e3e7f2d417f99138e12beee40057e5b8514e041cb6ea453bc585f555f0b14043bdc424
  HEAD_REF continuousBatchingMultiJobAddonCppFixup
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
