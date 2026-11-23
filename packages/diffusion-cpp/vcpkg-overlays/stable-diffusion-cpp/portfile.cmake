# stable-diffusion.cpp vcpkg overlay port
#
# Builds the stable-diffusion.cpp inference library and links against the
# system-installed ggml (provided by the separate ggml overlay port, pinned
# from the same engine branch date).
#
# Installed artefacts:
#   include/stable-diffusion.h   (main C API)
#   lib/libstable-diffusion.a    (static library)
#   share/stable-diffusion-cpp/  (CMake package config)
#
# GPU backend selection is handled at runtime via ggml's backend registry;
# on Android and desktop Linux the GPU backends are dlopen'd modules
# (hybrid GGML_BACKEND_DL, see the ggml port).
#
# 2026-11-01 engine with guarded per-context VAE/H3 controls (engine PR #64),
# Flux.2 VAE convolution fixes (engine PRs #65, #67) and optional Core ML
# UNet/TAE decoder sidecars (engine PR #69, SD_COREML, off by default),
# Flux.2 Metal VAE probing (engine PR #70), Strix H3 integration/docs
# (engine PR #72), Fibo reference-image capability reporting (engine PR #74),
# the SDXL Core ML UNet sidecar with chunked and mixed-bit models and the
# Metal GroupNorm fix for batched CFG (engine PR #73).
# WebP/WebM support auto-disables: upstream vendors them as git submodules
# under thirdparty/, which GitHub REF tarballs do not contain
# (SD_WEBP_DEFAULT/SD_WEBM_DEFAULT fall back to OFF).
vcpkg_from_github(
    OUT_SOURCE_PATH SOURCE_PATH
    REPO tetherto/qvac-ext-stable-diffusion.cpp
    REF 484c0959f8f76cbc93177a3478800f24441271eb
    SHA512 b20d5ed41cdf0094fce3a5a1792bc4ad6de90b26a4cdb1cfe23b5ca94f77144d2b7eeadc2c0a51694cc074f408449a21a84170c831e7a502baf585fdd2041263
)

# Only build Release — debug builds are not needed for the prebuild and can
# fail with MSVC iterator-debug-level mismatches.
set(VCPKG_BUILD_TYPE release)

vcpkg_check_features(
    OUT_FEATURE_OPTIONS FEATURE_OPTIONS
    FEATURES
        coreml SD_COREML
)

set(SD_LTO OFF)
if(VCPKG_TARGET_IS_WINDOWS)
    set(SD_LTO ON)
endif()

# --- Configure & build ---
vcpkg_cmake_configure(
    SOURCE_PATH "${SOURCE_PATH}"
    DISABLE_PARALLEL_CONFIGURE
    OPTIONS
        -DSD_BUILD_EXAMPLES=OFF
        -DSD_BUILD_SHARED_LIBS=OFF
        -DSD_USE_SYSTEM_GGML=ON
        -DSD_LTO=${SD_LTO}
        ${FEATURE_OPTIONS}
)

vcpkg_cmake_install()

# --- CMake package config ---
# Ship our own config that defines stable-diffusion::stable-diffusion with
# ggml as a transitive dependency (consumers find_package
# stable-diffusion-cpp). Upstream now installs its own config under
# lib/cmake/stable-diffusion; remove it so there is exactly one source of
# truth and vcpkg's misplaced-cmake-files check stays quiet.
file(REMOVE_RECURSE "${CURRENT_PACKAGES_DIR}/lib/cmake"
                    "${CURRENT_PACKAGES_DIR}/debug/lib/cmake")
file(INSTALL
    "${CMAKE_CURRENT_LIST_DIR}/stable-diffusion-cppConfig.cmake"
    "${CMAKE_CURRENT_LIST_DIR}/stable-diffusion-cppConfigVersion.cmake"
    DESTINATION "${CURRENT_PACKAGES_DIR}/share/stable-diffusion-cpp"
)
# The coreml sidecars call into Core ML from the static library, so
# consumers need the frameworks on their link line.
if("coreml" IN_LIST FEATURES)
    file(APPEND "${CURRENT_PACKAGES_DIR}/share/stable-diffusion-cpp/stable-diffusion-cppConfig.cmake" [[

set_property(TARGET stable-diffusion::stable-diffusion APPEND PROPERTY
    INTERFACE_LINK_LIBRARIES
        "-framework CoreML" "-framework Foundation" "-framework Accelerate"
)
]])
endif()

vcpkg_fixup_pkgconfig()

# --- Cleanup ---
file(REMOVE_RECURSE "${CURRENT_PACKAGES_DIR}/debug/include")
file(REMOVE_RECURSE "${CURRENT_PACKAGES_DIR}/debug/share")

set(VCPKG_POLICY_MISMATCHED_NUMBER_OF_BINARIES enabled)

file(INSTALL "${CMAKE_CURRENT_LIST_DIR}/usage" DESTINATION "${CURRENT_PACKAGES_DIR}/share/${PORT}")
vcpkg_install_copyright(FILE_LIST "${SOURCE_PATH}/LICENSE")
