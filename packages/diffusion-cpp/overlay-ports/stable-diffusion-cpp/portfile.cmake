# Published LTX IC-LoRA engine overlay, pinned to an immutable commit.
vcpkg_from_github(
    OUT_SOURCE_PATH SOURCE_PATH
    REPO tetherto/qvac-ext-stable-diffusion.cpp
    REF c58ed7fc499b1b1669284c5477faac5d423e1936
    SHA512 24242662916826f52665e3b9541b83cdc03388393b758bf256e6fa3d4d418cee5e0efb647e658c29d1add447c4e911acc323bfdda9d745ba3491cf89530948ff
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
