# stable-diffusion.cpp vcpkg overlay port
#
# Fetches stable-diffusion.cpp from GitHub (including the ggml submodule)
# and builds it as a static library on all platforms except Android, where
# each ggml GPU backend is compiled as a separate shared library loaded at
# runtime via GGML_BACKEND_DL (mirroring the qvac-fabric llama.cpp port).
#
# The port installs:
#   - include/stable-diffusion.h       (main C API)
#   - include/stb_image.h              (stb image loading)
#   - include/stb_image_write.h        (stb PNG encoding)
#   - lib/libstable-diffusion.a        (static library)
#   - share/stable-diffusion-cpp/      (CMake config)
#
# GPU backend selection is controlled via vcpkg features:
#   - metal   -> -DSD_METAL=ON   (macOS/iOS, auto-enabled on Apple)
#   - vulkan  -> -DSD_VULKAN=ON
#   - cuda    -> -DSD_CUDA=ON
#   - opencl  -> -DSD_OPENCL=ON  (Android/Adreno)
#
# In-place source edits applied after clone (see portfile for details):
#   1. Rename libggml-*.so → libqvac-diffusion-ggml-*.so so the shipped
#      Android libs don't clash with any system-installed ggml.
#      (Cannot use vcpkg_apply_patches — ggml is a git submodule with its
#       own .git so git apply on the parent silently skips those paths.)

set(SD_CPP_REPO "https://github.com/leejet/stable-diffusion.cpp.git")
# Pinned to release tag master-514-5792c66 (2026-03-01).
# Update this tag to pick up a newer upstream release.
set(SD_CPP_TAG "master-514-5792c66")
set(SOURCE_PATH "${CURRENT_BUILDTREES_DIR}/src/stable-diffusion-cpp-${SD_CPP_TAG}")

# vcpkg_from_git cannot fetch by SHA on GitHub (server restriction).
# We clone the specific release tag with --recurse-submodules so that
# the bundled ggml submodule is also initialised in one step.
if(NOT EXISTS "${SOURCE_PATH}/CMakeLists.txt")
    vcpkg_execute_required_process(
        COMMAND "${GIT}" clone
            --depth 1
            --recurse-submodules
            --shallow-submodules
            -b "${SD_CPP_TAG}"
            "${SD_CPP_REPO}"
            "${SOURCE_PATH}"
        WORKING_DIRECTORY "${CURRENT_BUILDTREES_DIR}"
        LOGNAME "git-clone-stable-diffusion-cpp"
    )
endif()

# --- Patch ggml submodule files ---
# vcpkg_apply_patches cannot modify ggml because it is a git submodule with its
# own .git — git apply on the parent repo silently skips submodule paths.
# We use cmake file() string replacement instead, which works on any file.

# 1. rename-ggml-libs:
#    a) set OUTPUT_NAME on each backend MODULE so the .so is
#       libqvac-diffusion-ggml-<backend>.so instead of libggml-<backend>.so.
set(_cmake_file "${SOURCE_PATH}/ggml/src/CMakeLists.txt")
file(READ "${_cmake_file}" _cmake_contents)
string(REPLACE
    "add_library(\${backend} MODULE \${ARGN})\n        # write the shared library"
    "add_library(\${backend} MODULE \${ARGN})\n        set_target_properties(\${backend} PROPERTIES OUTPUT_NAME \"qvac-diffusion-\${backend}\")\n        # write the shared library"
    _cmake_contents "${_cmake_contents}"
)
file(WRITE "${_cmake_file}" "${_cmake_contents}")

#    b) update backend_filename_prefix() so ggml_backend_load_best() searches
#       for the renamed libqvac-diffusion-ggml-* prefix at runtime.
set(_reg_file "${SOURCE_PATH}/ggml/src/ggml-backend-reg.cpp")
file(READ "${_reg_file}" _reg_contents)
string(REPLACE
    "return fs::u8path(\"ggml-\");"
    "return fs::u8path(\"qvac-diffusion-ggml-\");"
    _reg_contents "${_reg_contents}"
)
string(REPLACE
    "return fs::u8path(\"libggml-\");"
    "return fs::u8path(\"libqvac-diffusion-ggml-\");"
    _reg_contents "${_reg_contents}"
)
file(WRITE "${_reg_file}" "${_reg_contents}")

# --- Platform options (mirrors qvac-fabric pattern) ---
set(PLATFORM_OPTIONS)

if(VCPKG_TARGET_IS_OSX OR VCPKG_TARGET_IS_IOS)
    list(APPEND PLATFORM_OPTIONS -DSD_METAL=ON)
else()
    list(APPEND PLATFORM_OPTIONS -DSD_VULKAN=ON)
endif()

# GGML_BACKEND_DL: each GPU backend compiles as a separate .so loaded at
# runtime via dlopen. Enabled only on Android (matches qvac-fabric llama.cpp).
# On Linux/macOS/Windows the backends are statically linked into the addon.
if(VCPKG_TARGET_IS_ANDROID)
    set(DL_BACKENDS ON)
    list(APPEND PLATFORM_OPTIONS
        -DGGML_BACKEND_DL=ON
        -DGGML_CPU_ALL_VARIANTS=ON
        -DGGML_CPU_REPACK=ON
    )
else()
    set(DL_BACKENDS OFF)
    list(APPEND PLATFORM_OPTIONS -DGGML_BACKEND_DL=OFF)
endif()

# --- GPU feature flags ---
set(SD_GGML_CUDA   OFF)
set(SD_GGML_OPENCL OFF)
set(SD_FLASH_ATTN  OFF)
set(SD_CUDA_COMPILER_OPTION "")

if("cuda" IN_LIST FEATURES)
    set(SD_GGML_CUDA ON)
    # Locate nvcc explicitly — /usr/local/cuda/bin may not be on the PATH that
    # vcpkg's isolated cmake process inherits.
    find_program(NVCC_EXECUTABLE nvcc
        PATHS /usr/local/cuda/bin /usr/local/cuda-12.8/bin
        NO_DEFAULT_PATH
    )
    if(NOT NVCC_EXECUTABLE)
        find_program(NVCC_EXECUTABLE nvcc REQUIRED)
    endif()
    set(SD_CUDA_COMPILER_OPTION "-DCMAKE_CUDA_COMPILER=${NVCC_EXECUTABLE}")
    message(STATUS "CUDA compiler: ${NVCC_EXECUTABLE}")
endif()

if("opencl" IN_LIST FEATURES)
    set(SD_GGML_OPENCL ON)
endif()

if("flash-attn" IN_LIST FEATURES)
    set(SD_FLASH_ATTN ON)
endif()

# --- Configure and build ---
vcpkg_cmake_configure(
    SOURCE_PATH "${SOURCE_PATH}"
    OPTIONS
        -DBUILD_SHARED_LIBS=OFF
        -DSD_BUILD_EXAMPLES=OFF
        -DSD_BUILD_SHARED_LIBS=OFF
        -DSD_CUDA=${SD_GGML_CUDA}
        -DSD_OPENCL=${SD_GGML_OPENCL}
        -DSD_FLASH_ATTN=${SD_FLASH_ATTN}
        ${PLATFORM_OPTIONS}
        ${SD_CUDA_COMPILER_OPTION}
    MAYBE_UNUSED_VARIABLES
        SD_FLASH_ATTN
)

vcpkg_cmake_install()

# --- Install stb headers for PNG encode/decode in consumer code ---
if(EXISTS "${SOURCE_PATH}/thirdparty/stb/stb_image.h")
    file(INSTALL "${SOURCE_PATH}/thirdparty/stb/stb_image.h"
         DESTINATION "${CURRENT_PACKAGES_DIR}/include")
    file(INSTALL "${SOURCE_PATH}/thirdparty/stb/stb_image_write.h"
         DESTINATION "${CURRENT_PACKAGES_DIR}/include")
elseif(EXISTS "${SOURCE_PATH}/thirdparty/stb_image.h")
    file(INSTALL "${SOURCE_PATH}/thirdparty/stb_image.h"
         DESTINATION "${CURRENT_PACKAGES_DIR}/include")
    file(INSTALL "${SOURCE_PATH}/thirdparty/stb_image_write.h"
         DESTINATION "${CURRENT_PACKAGES_DIR}/include")
endif()

# --- Create CMake config for find_package(stable-diffusion-cpp CONFIG REQUIRED) ---
set(CONFIG_DIR "${CURRENT_PACKAGES_DIR}/share/stable-diffusion-cpp")
file(MAKE_DIRECTORY "${CONFIG_DIR}")

file(WRITE "${CONFIG_DIR}/stable-diffusion-cppConfig.cmake" [=[
get_filename_component(_SD_CPP_INSTALL_PREFIX "${CMAKE_CURRENT_LIST_DIR}/../.." ABSOLUTE)

find_library(STABLE_DIFFUSION_LIBRARY
    NAMES stable-diffusion
    PATHS "${_SD_CPP_INSTALL_PREFIX}/lib"
    NO_DEFAULT_PATH
    REQUIRED
)

find_path(STABLE_DIFFUSION_INCLUDE_DIR
    NAMES stable-diffusion.h
    PATHS "${_SD_CPP_INSTALL_PREFIX}/include"
    NO_DEFAULT_PATH
    REQUIRED
)

if(NOT TARGET stable-diffusion::stable-diffusion)
    add_library(stable-diffusion::stable-diffusion STATIC IMPORTED)
    set_target_properties(stable-diffusion::stable-diffusion PROPERTIES
        IMPORTED_LOCATION             "${STABLE_DIFFUSION_LIBRARY}"
        INTERFACE_INCLUDE_DIRECTORIES "${STABLE_DIFFUSION_INCLUDE_DIR}"
    )
endif()
]=])

file(WRITE "${CONFIG_DIR}/stable-diffusion-cppConfigVersion.cmake" [=[
set(PACKAGE_VERSION "0.0.1")
if(PACKAGE_FIND_VERSION VERSION_GREATER PACKAGE_VERSION)
    set(PACKAGE_VERSION_COMPATIBLE FALSE)
else()
    set(PACKAGE_VERSION_COMPATIBLE TRUE)
    if(PACKAGE_FIND_VERSION STREQUAL PACKAGE_VERSION)
        set(PACKAGE_VERSION_EXACT TRUE)
    endif()
endif()
]=])

# Remove debug include dir (no debug headers needed)
file(REMOVE_RECURSE "${CURRENT_PACKAGES_DIR}/debug/include")
file(REMOVE_RECURSE "${CURRENT_PACKAGES_DIR}/debug/share")

# Install license
vcpkg_install_copyright(FILE_LIST "${SOURCE_PATH}/LICENSE")

set(VCPKG_BUILD_TYPE release)
