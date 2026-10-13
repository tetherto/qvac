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
# Windows size optimizations from the 2026-08-11 branch PR:
# https://github.com/tetherto/qvac-ext-stable-diffusion.cpp/pull/56
# WebP/WebM support auto-disables: upstream vendors them as git submodules
# under thirdparty/, which GitHub REF tarballs do not contain
# (SD_WEBP_DEFAULT/SD_WEBM_DEFAULT fall back to OFF).
vcpkg_from_github(
    OUT_SOURCE_PATH SOURCE_PATH
    REPO tetherto/qvac-ext-stable-diffusion.cpp
    REF 683ac894cbc6b4d6d448ec3c363fba137e97d83d
    SHA512 93212a36eff0ca82b9682c8ff17c39fb131dedb3fb021660e8f23cb9b43847d75170f3a177a839862821493756311c443c7f7a90ed6d4eeaa08cb9a76374f6db
)

# Even under SD_USE_SYSTEM_GGML the sources reach into one ggml *internal*
# header (src/core/ggml_extend_backend.cpp includes "ggml/src/ggml-impl.h");
# developers get it from the ggml git submodule, which REF tarballs do not
# contain. Fetch the same qvac-ext-ggml commit the ggml port builds and place
# it at the submodule path so the internal header matches the linked ggml
# exactly. KEEP THIS REF IN LOCKSTEP with ../ggml/portfile.cmake.
vcpkg_from_github(
    OUT_SOURCE_PATH GGML_SOURCE_PATH
    REPO tetherto/qvac-ext-ggml
    REF 75b340f542ea0e992a8acfa9da430dfda57b5fba
    SHA512 4ff0bed6ec9e017c359910ba5443f7ad8a7d688d88cda604a34356496175ce007ec5183fbeafece832b55d2d0ce0579b1b7218f1217659dda82a05b9528272e3
)
file(REMOVE_RECURSE "${SOURCE_PATH}/ggml")
file(MAKE_DIRECTORY "${SOURCE_PATH}/ggml")
file(GLOB _ggml_tree LIST_DIRECTORIES true "${GGML_SOURCE_PATH}/*")
file(COPY ${_ggml_tree} DESTINATION "${SOURCE_PATH}/ggml")

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
