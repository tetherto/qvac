# Published LTX IC-LoRA engine overlay, pinned to an immutable commit.
vcpkg_from_github(
    OUT_SOURCE_PATH SOURCE_PATH
    REPO tetherto/qvac-ext-stable-diffusion.cpp
    REF 3df163deb46c2f55d2b8891216fbe8cae76fcb8d
    SHA512 241906a63962830d0275653cafd766b4c9752b6e6f6a04fad854affa6c100fa9b0788877db3c3f6377735a1aa0c3ef4562f539672c8fa3e6905238ca74decda5
    HEAD_REF 2026-07-03-ltx-lora
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
