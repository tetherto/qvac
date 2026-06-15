# qvac-lint-cpp — LOCAL OVERLAY PORT.
#
# The shared registry revision currently fetched by the TTS GGML coverage job
# resolves qvac-lint-cpp via a pinned qvac.git commit that is no longer
# fetchable in CI. Build the in-repo lint-cpp source directly instead so this
# package can keep using the published registry baseline for everything else.

get_filename_component(
    SOURCE_PATH
    "${CURRENT_PORT_DIR}/../../../lint-cpp"
    REALPATH
)

if(NOT EXISTS "${SOURCE_PATH}/CMakeLists.txt")
    message(FATAL_ERROR
        "qvac-lint-cpp overlay source missing at ${SOURCE_PATH}")
endif()

vcpkg_cmake_configure(SOURCE_PATH "${SOURCE_PATH}")
vcpkg_cmake_install()

set(VCPKG_POLICY_EMPTY_INCLUDE_FOLDER enabled)
file(REMOVE_RECURSE "${CURRENT_PACKAGES_DIR}/debug")

vcpkg_install_copyright(FILE_LIST "${SOURCE_PATH}/LICENSE")
