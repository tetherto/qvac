# stable-diffusion.cpp vcpkg overlay port
#
# Builds the stable-diffusion.cpp inference library and links against the
# system-installed ggml (provided by the separate ggml overlay port).
#
# Installed artefacts:
#   include/stable-diffusion.h   (main C API)
#   lib/libstable-diffusion.a    (static library)
#   share/stable-diffusion-cpp/  (CMake package config)
#
# GPU backend selection is controlled via vcpkg features which forward to
# the ggml dependency.  The SD_* options below set compile-time defines
# (e.g. -DSD_USE_CUDA) that the stable-diffusion.cpp source requires.

# Pinned to release tag master-514-5792c66 (2026-03-01).
vcpkg_from_github(
    OUT_SOURCE_PATH SOURCE_PATH
    REPO tetherto/qvac-ext-stable-diffusion.cpp
    REF 5792c668798083f9f6d57dac66fbc62ddfdac405
    SHA512 9bdf945d27ea24d9ea8218a7b875b6d1346711122723453840f4648cd862de3be28e37736ce0ef46ed304cbe810593dfa4264eec969c9e0c8dafb854298280f7
    HEAD_REF master
    PATCHES
        sd-cpu-only.patch
        abort-callback.patch
        fix-failure-path-cleanup.patch
)

# --- GPU feature flags ---
# These set SD_* cache variables which the upstream CMakeLists.txt translates
# into -DSD_USE_<backend> compile definitions.  The actual ggml backend
# libraries are already built and installed by the ggml port.

set(SD_METAL  OFF)
set(SD_VULKAN OFF)
set(SD_CUDA   OFF)
set(SD_OPENCL OFF)
set(SD_FLASH_ATTN OFF)

if("metal" IN_LIST FEATURES)
    set(SD_METAL ON)
endif()

if("vulkan" IN_LIST FEATURES)
    set(SD_VULKAN ON)
endif()

if("cuda" IN_LIST FEATURES)
    set(SD_CUDA ON)
endif()

if("opencl" IN_LIST FEATURES)
    set(SD_OPENCL ON)
endif()

if("flash-attn" IN_LIST FEATURES)
    set(SD_FLASH_ATTN ON)
endif()

# Only build Release — debug builds are not needed for the prebuild and can
# fail with MSVC iterator-debug-level mismatches.
set(VCPKG_BUILD_TYPE release)

# --- Configure & build ---
vcpkg_cmake_configure(
    SOURCE_PATH "${SOURCE_PATH}"
    DISABLE_PARALLEL_CONFIGURE
    OPTIONS
        -DSD_BUILD_EXAMPLES=OFF
        -DSD_BUILD_SHARED_LIBS=OFF
        -DSD_USE_SYSTEM_GGML=ON
        -DSD_METAL=${SD_METAL}
        -DSD_VULKAN=${SD_VULKAN}
        -DSD_CUDA=${SD_CUDA}
        -DSD_OPENCL=${SD_OPENCL}
        -DSD_FLASH_ATTN=${SD_FLASH_ATTN}
    MAYBE_UNUSED_VARIABLES
        SD_FLASH_ATTN
)

vcpkg_cmake_install()

# --- CMake package config ---
# Upstream does not export a CMake config, so we ship our own that defines
# stable-diffusion::stable-diffusion with ggml as a transitive dependency.
file(INSTALL
    "${CMAKE_CURRENT_LIST_DIR}/stable-diffusion-cppConfig.cmake"
    "${CMAKE_CURRENT_LIST_DIR}/stable-diffusion-cppConfigVersion.cmake"
    DESTINATION "${CURRENT_PACKAGES_DIR}/share/stable-diffusion-cpp"
)

# --- Cleanup ---
file(REMOVE_RECURSE "${CURRENT_PACKAGES_DIR}/debug/include")
file(REMOVE_RECURSE "${CURRENT_PACKAGES_DIR}/debug/share")

vcpkg_install_copyright(FILE_LIST "${SOURCE_PATH}/LICENSE")
