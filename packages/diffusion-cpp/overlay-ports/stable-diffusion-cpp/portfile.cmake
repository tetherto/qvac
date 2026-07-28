# Local development overlay for the LTX IC-LoRA engine pull request.
#
# The ref is an immutable, signed commit from
# tetherto/qvac-ext-stable-diffusion.cpp#25. Promote the same commit to
# qvac-registry-vcpkg before removing this overlay.
vcpkg_from_github(
    OUT_SOURCE_PATH SOURCE_PATH
    REPO tetherto/qvac-ext-stable-diffusion.cpp
    REF 146ede0c888b5efa7db9521aefd4164a42651242
    SHA512 9153b50c58e49c8a2ccc678ef1d7b6fb47866575dabf09fd0a895832a3535f7be96b17f2d05fdab79038eec096ecf8972d684110d65220e4ac470d47c64e22f9
)

set(SD_FLASH_ATTN OFF)
if("flash-attn" IN_LIST FEATURES)
    set(SD_FLASH_ATTN ON)
endif()

# Prebuilds consume only release artefacts. Debug builds can also fail from
# MSVC iterator-debug-level mismatches with the separately packaged ggml.
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

# The engine does not export a CMake package. Install the QVAC wrapper that
# provides stable-diffusion::stable-diffusion and forwards ggml transitively.
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
