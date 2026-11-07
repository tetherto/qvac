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
# Server CUDA build documentation and matching ggml submodule:
# https://github.com/tetherto/qvac-ext-stable-diffusion.cpp/pull/59
# Windows size optimizations merged into the 2026-08-11 branch:
# https://github.com/tetherto/qvac-ext-stable-diffusion.cpp/pull/56
# WebP/WebM support auto-disables: upstream vendors them as git submodules
# under thirdparty/, which GitHub REF tarballs do not contain
# (SD_WEBP_DEFAULT/SD_WEBM_DEFAULT fall back to OFF).
vcpkg_from_github(
    OUT_SOURCE_PATH SOURCE_PATH
    REPO tetherto/qvac-ext-stable-diffusion.cpp
    REF 67fd0f590e8de432e6bb95fb05b0c3fdfdb2a1dd
    SHA512 12edbd114fd74512b02bbecd11391f2f4522e8785df7a73f949d8ee3e076878b3f48d27a7ccef8379c83a3f5ea30231aa2b6db7b7962f999d70861eb475f2f5c
    PATCHES performance-profiles.patch
)

# Even under SD_USE_SYSTEM_GGML the sources reach into one ggml *internal*
# header (src/core/ggml_extend_backend.cpp includes "ggml/src/ggml-impl.h");
# developers get it from the ggml git submodule, which REF tarballs do not
# contain. Fetch the same qvac-ext-ggml commit the ggml port builds and place
# it at the submodule path so the internal header matches the linked ggml
# exactly. KEEP THIS REF IN LOCKSTEP with ports/ggml/portfile.cmake.
vcpkg_from_github(
    OUT_SOURCE_PATH GGML_SOURCE_PATH
    REPO tetherto/qvac-ext-ggml
    REF a4adfcb1304fb05b64473f1fe8d678bbce7a9ce0
    SHA512 15a7828668d60b2b630d906433370d792c597654af3ebcfe7c5b9121b563700db7074fb15934cf6d3ee55a4890bc48873c691b2ea2e5cb3d75e9ba412febdbc5
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
