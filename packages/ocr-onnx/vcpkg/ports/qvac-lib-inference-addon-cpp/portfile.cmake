# Dev overlay: build qvac-lib-inference-addon-cpp 1.3.0 from the addon-cpp
# snapshot branch (jesusmb1995/qvac @ continuousBatchingD10AddonCpp1) instead
# of the published registry version, to verify this addon builds unchanged
# against the 1.3.0 multi-job scheduler (backwards-compatibility check; same
# REF/SHA512 as the llm-llamacpp portfile_dev overlay). Bump REF/SHA512 (and
# the overlay port-version) when that branch moves. To fall back to the
# registry version, remove this port directory and the "overlay-ports" entry
# in vcpkg-configuration.json.
vcpkg_from_github(
  OUT_SOURCE_PATH SOURCE_PATH
  REPO jesusmb1995/qvac
  REF 229f2c0bdcbc88dc683a2657651a5b224d4ab1c4
  SHA512 b5644504a0973d8d8602ed5c29cf94f9c04115fdb514c211a5de4300a9914301d854399ebf0261765e087e5fb80aea9fc9ef6b069e41d3a5b7de88db52e8667e
  HEAD_REF continuousBatchingD10AddonCpp1
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
