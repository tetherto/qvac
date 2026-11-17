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
# 2026-11-01 engine with guarded per-context VAE/H3 controls (engine PR #64).
# WebP/WebM support auto-disables: upstream vendors them as git submodules
# under thirdparty/, which GitHub REF tarballs do not contain
# (SD_WEBP_DEFAULT/SD_WEBM_DEFAULT fall back to OFF).
vcpkg_from_github(
    OUT_SOURCE_PATH SOURCE_PATH
    REPO tetherto/qvac-ext-stable-diffusion.cpp
    REF bc53357484bc5d2ba08fbe5301dae192e5b9a176
    SHA512 dced9d52efbf8ae7b35cd9e81816190f85178a631c6166095034375d92e0847125f435ec8fed4e7642817158ceb5f5967d34f71b83fcd89756b5d969efa5f71a
)

# Only build Release — debug builds are not needed for the prebuild and can
# fail with MSVC iterator-debug-level mismatches.
set(VCPKG_BUILD_TYPE release)

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

vcpkg_fixup_pkgconfig()

# --- Cleanup ---
file(REMOVE_RECURSE "${CURRENT_PACKAGES_DIR}/debug/include")
file(REMOVE_RECURSE "${CURRENT_PACKAGES_DIR}/debug/share")

set(VCPKG_POLICY_MISMATCHED_NUMBER_OF_BINARIES enabled)

file(INSTALL "${CMAKE_CURRENT_LIST_DIR}/usage" DESTINATION "${CURRENT_PACKAGES_DIR}/share/${PORT}")
vcpkg_install_copyright(FILE_LIST "${SOURCE_PATH}/LICENSE")
