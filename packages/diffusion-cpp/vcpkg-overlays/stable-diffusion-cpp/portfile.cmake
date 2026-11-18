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
# UNet/TAE decoder sidecars (engine PR #69, SD_COREML, off by default).
# WebP/WebM support auto-disables: upstream vendors them as git submodules
# under thirdparty/, which GitHub REF tarballs do not contain
# (SD_WEBP_DEFAULT/SD_WEBM_DEFAULT fall back to OFF).
vcpkg_from_github(
    OUT_SOURCE_PATH SOURCE_PATH
    REPO tetherto/qvac-ext-stable-diffusion.cpp
    REF 9e544e85276f330f861dd8f4e60d5953df7fae55
    SHA512 2a195b5a273f6104adc6e46aa62a700b60d8603f1e110efe382d3c0d8649fc0d0d3821204d8ea139d2b48c29286254fc5e4217f0cf0c9d59c7518cb610e6608a
)

# Only build Release — debug builds are not needed for the prebuild and can
# fail with MSVC iterator-debug-level mismatches.
set(VCPKG_BUILD_TYPE release)

vcpkg_check_features(
    OUT_FEATURE_OPTIONS FEATURE_OPTIONS
    FEATURES
        coreml SD_COREML
)
# Consumed by stable-diffusion-cppConfig.cmake.in: the static library needs
# the CoreML frameworks on the consumer's link line.
set(SD_CPP_COREML OFF)
if("coreml" IN_LIST FEATURES)
    set(SD_CPP_COREML ON)
endif()

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
configure_file(
    "${CMAKE_CURRENT_LIST_DIR}/stable-diffusion-cppConfig.cmake.in"
    "${CURRENT_PACKAGES_DIR}/share/stable-diffusion-cpp/stable-diffusion-cppConfig.cmake"
    @ONLY
)
file(INSTALL
    "${CMAKE_CURRENT_LIST_DIR}/stable-diffusion-cppConfigVersion.cmake"
    DESTINATION "${CURRENT_PACKAGES_DIR}/share/stable-diffusion-cpp"
)

vcpkg_fixup_pkgconfig()

# --- Cleanup ---
file(REMOVE_RECURSE "${CURRENT_PACKAGES_DIR}/debug/include")
file(REMOVE_RECURSE "${CURRENT_PACKAGES_DIR}/debug/share")

set(VCPKG_POLICY_MISMATCHED_NUMBER_OF_BINARIES enabled)

file(INSTALL "${CMAKE_CURRENT_LIST_DIR}/usage" DESTINATION "${CURRENT_PACKAGES_DIR}/share/${PORT}")
vcpkg_install_copyright(FILE_LIST "${SOURCE_PATH}/LICENSE")
