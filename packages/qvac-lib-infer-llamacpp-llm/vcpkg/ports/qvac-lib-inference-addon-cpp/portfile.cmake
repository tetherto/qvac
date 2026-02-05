vcpkg_from_git(
  OUT_SOURCE_PATH SOURCE_PATH
  URL git@github.com:jesusmb1995/qvac-lib-inference-addon-cpp.git
  REF 8423ca004b13b51a097519c712d870f70ef4947a
)

vcpkg_check_features(
  OUT_FEATURE_OPTIONS FEATURE_OPTIONS
  FEATURES
    tests BUILD_TESTING
)

vcpkg_cmake_configure(
  SOURCE_PATH "${SOURCE_PATH}"
  DISABLE_PARALLEL_CONFIGURE
  OPTIONS
    ${FEATURE_OPTIONS}
)

vcpkg_cmake_install()

# Patch FinetuningParameters.hpp to add missing fields after installation
file(READ "${CURRENT_PACKAGES_DIR}/include/qvac-lib-inference-addon-cpp/FinetuningParameters.hpp" FINETUNING_PARAMS_CONTENT)
# Always apply patch if contextLength is missing (indicates file needs updating)
if(NOT FINETUNING_PARAMS_CONTENT MATCHES "contextLength")
  # Read the patched version from our patches directory
  file(READ "${CMAKE_CURRENT_LIST_DIR}/patches/FinetuningParameters.hpp.patched" PATCHED_CONTENT)
  file(WRITE "${CURRENT_PACKAGES_DIR}/include/qvac-lib-inference-addon-cpp/FinetuningParameters.hpp" "${PATCHED_CONTENT}")
endif()

file(REMOVE_RECURSE "${CURRENT_PACKAGES_DIR}/debug")

file(
  INSTALL "${SOURCE_PATH}/LICENSE"
  DESTINATION "${CURRENT_PACKAGES_DIR}/share/${PORT}"
  RENAME copyright
)
