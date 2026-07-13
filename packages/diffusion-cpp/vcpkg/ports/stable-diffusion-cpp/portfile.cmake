# stable-diffusion.cpp vcpkg overlay port
#
# Builds the stable-diffusion.cpp inference library and links against the
# system-installed ggml from the registry. Only stable-diffusion-cpp is
# overlaid here; ggml remains resolved from qvac-registry-vcpkg.
#
# PR #20: https://github.com/tetherto/qvac-ext-stable-diffusion.cpp/pull/20
# a547731 adds follow-up Ideogram review fixes: explicit failure when CFG is
# requested without a loaded unconditional model, and correct FP8 weight_scale
# ordering (applied to the weight product before bias).
vcpkg_from_github(
    OUT_SOURCE_PATH SOURCE_PATH
    REPO tetherto/qvac-ext-stable-diffusion.cpp
    REF a5477315f804bbc50279456daaf2c02f5e2c1aca
    SHA512 fbb4c4c890887760a01e2dd537776ced59ddc91453dc7d6d015728ae7cc7506f9724f7f58a87b9ff5977a95dc6308f045b107419a831f70d9161f90cf0c9da23
)

set(SD_FLASH_ATTN OFF)

if("flash-attn" IN_LIST FEATURES)
    set(SD_FLASH_ATTN ON)
endif()

# Only build Release; debug builds are not needed for prebuilds and can fail
# with MSVC iterator-debug-level mismatches.
set(VCPKG_BUILD_TYPE release)

vcpkg_cmake_configure(
    SOURCE_PATH "${SOURCE_PATH}"
    DISABLE_PARALLEL_CONFIGURE
    OPTIONS
        -DSD_BUILD_EXAMPLES=OFF
        -DSD_BUILD_SHARED_LIBS=OFF
        -DSD_USE_SYSTEM_GGML=ON
        -DSD_FLASH_ATTN=${SD_FLASH_ATTN}
    MAYBE_UNUSED_VARIABLES
        SD_FLASH_ATTN
)

vcpkg_cmake_install()

# Upstream does not export a CMake config, so ship one that defines
# stable-diffusion::stable-diffusion with ggml as a transitive dependency.
file(INSTALL
    "${CMAKE_CURRENT_LIST_DIR}/stable-diffusion-cppConfig.cmake"
    "${CMAKE_CURRENT_LIST_DIR}/stable-diffusion-cppConfigVersion.cmake"
    DESTINATION "${CURRENT_PACKAGES_DIR}/share/stable-diffusion-cpp"
)

file(REMOVE_RECURSE "${CURRENT_PACKAGES_DIR}/debug/include")
file(REMOVE_RECURSE "${CURRENT_PACKAGES_DIR}/debug/share")

set(VCPKG_POLICY_MISMATCHED_NUMBER_OF_BINARIES enabled)

file(INSTALL "${CMAKE_CURRENT_LIST_DIR}/usage" DESTINATION "${CURRENT_PACKAGES_DIR}/share/${PORT}")
vcpkg_install_copyright(FILE_LIST "${SOURCE_PATH}/LICENSE")
