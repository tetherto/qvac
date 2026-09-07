vcpkg_from_github(
    OUT_SOURCE_PATH SOURCE_PATH
    REPO tetherto/qvac-ext-ggml
    REF cddbc91717dc5eb8f58f5dfb32da27fbd7f3ad3f
    SHA512 c57ebfbab587ab335922ff6791e79f72b8e1d2f3540b978ace6a52e67948e959538607a2fefbbfda7afafdd5ae2178cb4db6d319beea0a81fe8bfa52713778f7
    HEAD_REF speech
)

set(GGML_METAL  OFF)
set(GGML_VULKAN OFF)
set(GGML_CUDA   OFF)
set(GGML_OPENCL OFF)
set(GGML_METAL_FUSE_MV_BIAS OFF)

if("metal" IN_LIST FEATURES)
    set(GGML_METAL ON)
endif()

# Off by default: the chatterbox Q-variant mul_mv + bias/residual fusion
# produces zero tokens on parakeet's EOU q8_0 joint network. Consumers
# whose models stay clear of that pattern can opt in for the speedup.
if("metal-fuse-mv-bias" IN_LIST FEATURES)
    set(GGML_METAL_FUSE_MV_BIAS ON)
endif()

if("vulkan" IN_LIST FEATURES)
    set(GGML_VULKAN ON)
endif()

set(GGML_CUDA_COMPILER_OPTION "")
set(GGML_CUDA_ARCHITECTURES_OPTION "")
set(GGML_CUDA_GRAPHS_OPTION "")

if("cuda" IN_LIST FEATURES)
    set(GGML_CUDA ON)
    # CUDA graph capture is off in the fork's CMake default; the speech stack
    # turns it on here, where the decode loops are launch-bound.
    set(GGML_CUDA_GRAPHS_OPTION -DGGML_CUDA_GRAPHS=ON)
    # An explicitly provisioned toolkit wins over whatever the host has at
    # /usr/local/cuda: CI's setup-cuda exports CUDACXX and CUDA_PATH, and the
    # 120a-real architecture below needs CUDA 13, so an older system toolkit
    # must not silently shadow the pin. Mirrors qvac-fabric's discovery order.
    if(DEFINED ENV{CUDACXX} AND EXISTS "$ENV{CUDACXX}")
        set(NVCC_EXECUTABLE "$ENV{CUDACXX}")
    endif()
    if(NOT NVCC_EXECUTABLE AND DEFINED ENV{CUDA_PATH})
        find_program(NVCC_EXECUTABLE nvcc PATHS "$ENV{CUDA_PATH}/bin" NO_DEFAULT_PATH)
    endif()
    if(NOT NVCC_EXECUTABLE)
        find_program(NVCC_EXECUTABLE nvcc)
    endif()
    if(NOT NVCC_EXECUTABLE)
        find_program(NVCC_EXECUTABLE nvcc PATHS /usr/local/cuda/bin NO_DEFAULT_PATH)
    endif()
    if(NOT NVCC_EXECUTABLE)
        message(FATAL_ERROR "ggml-speech: the cuda feature requires a CUDA 13 toolkit providing nvcc (checked CUDACXX, CUDA_PATH/bin, PATH and /usr/local/cuda/bin).")
    endif()

    # Refuse a pre-13 toolkit rather than failing deep in nvcc: CUDA 13 is what
    # drops sm_50/61/70 (so those stay excluded without listing them) and what
    # provides every target below. CI provisions 13.2 today and dev boxes run
    # 13.3; both satisfy this.
    execute_process(
        COMMAND "${NVCC_EXECUTABLE}" --version
        OUTPUT_VARIABLE NVCC_VERSION_OUTPUT
        ERROR_QUIET
    )
    string(REGEX MATCH "release ([0-9]+)\\.([0-9]+)" _ "${NVCC_VERSION_OUTPUT}")
    set(NVCC_VERSION "${CMAKE_MATCH_1}.${CMAKE_MATCH_2}")
    if(NVCC_VERSION VERSION_LESS "13.0")
        message(FATAL_ERROR "ggml-speech: the cuda feature needs CUDA >= 13.0, found ${NVCC_VERSION} at ${NVCC_EXECUTABLE}. Point CUDACXX or CUDA_PATH at a CUDA 13 toolkit.")
    endif()

    # Every architecture the published prebuilds target, native. Turing through
    # Blackwell each get their own cubin, and 80-virtual carries the PTX the
    # driver JITs forward from on anything newer than this list. sm_50/61/70
    # need no exclusion: CUDA 13 no longer supports them.
    if(VCPKG_TARGET_ARCHITECTURE STREQUAL "arm64")
        # arm64 counterparts: Jetson Orin (sm_87), Grace-Hopper (sm_90) and
        # GB10 / DGX Spark (sm_121a) native; 80-virtual covers discrete
        # Ampere+ cards on arm64 hosts and newer parts through PTX JIT.
        set(GGML_CUDA_ARCHITECTURES_OPTION "-DCMAKE_CUDA_ARCHITECTURES=80-virtual\\;87-real\\;90-real\\;121a-real")
    else()
        set(GGML_CUDA_ARCHITECTURES_OPTION "-DCMAKE_CUDA_ARCHITECTURES=75-real\\;80-real\\;80-virtual\\;86-real\\;89-real\\;90-real\\;120a-real\\;121a-real")
    endif()
    set(GGML_CUDA_COMPILER_OPTION "-DCMAKE_CUDA_COMPILER=${NVCC_EXECUTABLE}")
    message(STATUS "CUDA compiler: ${NVCC_EXECUTABLE} (${NVCC_VERSION})")
endif()

if("opencl" IN_LIST FEATURES)
    set(GGML_OPENCL ON)
endif()

if(VCPKG_TARGET_IS_ANDROID AND "vulkan" IN_LIST FEATURES)
    include(${CMAKE_CURRENT_LIST_DIR}/android-vulkan-version.cmake)
    detect_ndk_vulkan_version()
    message(STATUS "NDK Vulkan version: ${vulkan_version}")

    file(DOWNLOAD
        "https://github.com/KhronosGroup/Vulkan-Headers/archive/refs/tags/v${vulkan_version}.tar.gz"
        "${SOURCE_PATH}/vulkan-hpp-${vulkan_version}.tar.gz"
        TLS_VERIFY ON
    )
    file(ARCHIVE_EXTRACT
        INPUT "${SOURCE_PATH}/vulkan-hpp-${vulkan_version}.tar.gz"
        DESTINATION "${SOURCE_PATH}"
        PATTERNS "*.hpp"
    )
    file(COPY "${SOURCE_PATH}/Vulkan-Headers-${vulkan_version}/include/"
         DESTINATION "${SOURCE_PATH}/src/")
endif()

set(PLATFORM_OPTIONS)

if(VCPKG_TARGET_IS_IOS)
    list(APPEND PLATFORM_OPTIONS -DGGML_BLAS=OFF -DGGML_ACCELERATE=OFF)
endif()

# Hybrid Android backend mode: GPU backends and per-arch CPU variants are
# built as MODULE .so files and dlopen'd at runtime, so ggml-cpu's variant
# scoring picks the highest feature tier the running device supports.
if(VCPKG_TARGET_IS_ANDROID)
    list(APPEND PLATFORM_OPTIONS
        -DGGML_BACKEND_DL=ON
        -DGGML_CPU_ALL_VARIANTS=ON
        -DGGML_CPU_REPACK=ON
        -DGGML_VULKAN_DISABLE_COOPMAT=ON
        -DGGML_VULKAN_DISABLE_COOPMAT2=ON
    )
endif()

# Desktop hybrid MODULE packaging, in two flavours sharing one option set:
#
# - Desktop aarch64 Linux, always: same per-arch CPU-variant packaging as
#   Android. Without it, this non-GGML_NATIVE build lands on a plain armv8-a
#   baseline and compiles out the dotprod/fp16/i8mm kernels; per-tier MODULE
#   .so files scored at first use keep the prebuild fast and SIGILL-safe on
#   any host. With the cuda feature, the CUDA backend simply becomes one
#   more runtime-loaded module.
#
# - Desktop x64 (Linux and Windows) with CUDA: a statically linked ggml-cuda
#   hands the consuming addon hard references on the CUDA runtime libraries
#   (DT_NEEDED entries on libcuda/libcudart/libcublas; DLL imports on
#   cudart64/cublas64/nvcuda), so the addon fails to load on every host
#   without an NVIDIA driver plus the CUDA runtime. Built as MODULEs, only
#   the CUDA backend module carries those references; the registry loader
#   skips it on hosts that cannot resolve them and the cascade falls back to
#   Vulkan or CPU.
set(QVAC_LINUX_ARM64_DL_CPU OFF)
if(VCPKG_TARGET_IS_LINUX AND VCPKG_TARGET_ARCHITECTURE STREQUAL "arm64")
    set(QVAC_LINUX_ARM64_DL_CPU ON)
endif()
set(QVAC_DESKTOP_DL_GPU OFF)
if((VCPKG_TARGET_IS_LINUX OR VCPKG_TARGET_IS_WINDOWS)
        AND VCPKG_TARGET_ARCHITECTURE STREQUAL "x64"
        AND "cuda" IN_LIST FEATURES)
    set(QVAC_DESKTOP_DL_GPU ON)
endif()
set(QVAC_DESKTOP_DL OFF)
if(QVAC_LINUX_ARM64_DL_CPU OR QVAC_DESKTOP_DL_GPU)
    set(QVAC_DESKTOP_DL ON)
    list(APPEND PLATFORM_OPTIONS
        -DGGML_BACKEND_DL=ON
        -DGGML_CPU_ALL_VARIANTS=ON
        -DGGML_CPU_REPACK=ON
    )
    if(NOT VCPKG_TARGET_IS_WINDOWS)
        # Link the C++ runtime statically into the modules: a module with
        # NEEDED libc++.so.1 fails to dlopen on a stock host and the registry
        # loader skips it silently, leaving no CPU device registered. Composed
        # with VCPKG_LINKER_FLAGS so the triplet's own -stdlib flag survives.
        # On Windows the triplet's static CRT covers this instead.
        list(APPEND PLATFORM_OPTIONS
            "-DCMAKE_MODULE_LINKER_FLAGS=${VCPKG_LINKER_FLAGS} -static-libstdc++"
        )
    endif()
endif()

vcpkg_cmake_configure(
    SOURCE_PATH "${SOURCE_PATH}"
    OPTIONS
        -DBUILD_SHARED_LIBS=OFF
        -DGGML_NATIVE=OFF
        -DGGML_CCACHE=OFF
        -DGGML_OPENMP=OFF
        -DGGML_LLAMAFILE=OFF
        -DGGML_BUILD_TESTS=OFF
        -DGGML_BUILD_EXAMPLES=OFF
        -DGGML_METAL=${GGML_METAL}
        -DGGML_VULKAN=${GGML_VULKAN}
        -DGGML_CUDA=${GGML_CUDA}
        -DGGML_OPENCL=${GGML_OPENCL}
        -DGGML_METAL_FUSE_MV_BIAS=${GGML_METAL_FUSE_MV_BIAS}
        -DGGML_LIB_OUTPUT_PREFIX=qvac-speech-
        ${GGML_CUDA_COMPILER_OPTION}
        ${GGML_CUDA_ARCHITECTURES_OPTION}
        ${GGML_CUDA_GRAPHS_OPTION}
        ${PLATFORM_OPTIONS}
)

vcpkg_cmake_install()

# Pick up the MODULE backend .so files ggml builds into the buildtree's
# bin/ directory (Android dynamic-backend mode). cmake install() doesn't
# move them by default.
if(VCPKG_TARGET_IS_ANDROID)
    file(GLOB _backend_sos
        "${CURRENT_BUILDTREES_DIR}/${TARGET_TRIPLET}-rel/bin/libqvac-speech-ggml-*.so"
    )
    if(_backend_sos)
        file(INSTALL ${_backend_sos} DESTINATION "${CURRENT_PACKAGES_DIR}/lib")
    endif()
endif()

# Desktop MODULE backend pickup: ggml installs the modules into bin/ (on
# Linux as versioned files plus symlinks), but the runtime loader matches
# only a plain `.so`/`.dll` and the addons stage backends by copying a lib/
# glob, which would copy a symlink without its target. Dereference onto real
# files in lib/ and drop bin/ (which also keeps the static triplet's
# post-build checks quiet).
if(QVAC_DESKTOP_DL)
    if(VCPKG_TARGET_IS_WINDOWS)
        set(_backend_mod_glob "qvac-speech-ggml-*.dll")
    else()
        set(_backend_mod_glob "libqvac-speech-ggml-*.so")
    endif()
    foreach(_cfg "" "/debug")
        file(GLOB _backend_mods
            "${CURRENT_PACKAGES_DIR}${_cfg}/bin/${_backend_mod_glob}")
        foreach(_mod IN LISTS _backend_mods)
            get_filename_component(_mod_name "${_mod}" NAME)
            file(REAL_PATH "${_mod}" _mod_real)
            file(COPY_FILE "${_mod_real}"
                 "${CURRENT_PACKAGES_DIR}${_cfg}/lib/${_mod_name}")
        endforeach()
        file(REMOVE_RECURSE "${CURRENT_PACKAGES_DIR}${_cfg}/bin")
    endforeach()
endif()

# Do not ship the SVE-bearing CPU variants: ggml's SVE paths are
# several times slower than NEON dotprod/fp16 on the 128-bit-vector
# cores of the desktop arm64-linux fleet, and the runtime score would
# pick them on SVE hardware. Revisit with an SVE-free i8mm tier.
if(QVAC_LINUX_ARM64_DL_CPU)
    foreach(_cfg "" "/debug")
        foreach(_sve_tier armv8.2_3 armv8.6_1 armv8.6_2 armv9.2_1 armv9.2_2)
            file(REMOVE
                "${CURRENT_PACKAGES_DIR}${_cfg}/lib/libqvac-speech-ggml-cpu-${_sve_tier}.so")
        endforeach()
    endforeach()
endif()

vcpkg_cmake_config_fixup(PACKAGE_NAME ggml CONFIG_PATH lib/cmake/ggml)

if(EXISTS "${CURRENT_PACKAGES_DIR}/share/pkgconfig/ggml.pc")
    file(MAKE_DIRECTORY "${CURRENT_PACKAGES_DIR}/lib/pkgconfig")
    file(RENAME "${CURRENT_PACKAGES_DIR}/share/pkgconfig/ggml.pc"
                "${CURRENT_PACKAGES_DIR}/lib/pkgconfig/ggml.pc")
endif()
if(EXISTS "${CURRENT_PACKAGES_DIR}/debug/share/pkgconfig/ggml.pc")
    file(MAKE_DIRECTORY "${CURRENT_PACKAGES_DIR}/debug/lib/pkgconfig")
    file(RENAME "${CURRENT_PACKAGES_DIR}/debug/share/pkgconfig/ggml.pc"
                "${CURRENT_PACKAGES_DIR}/debug/lib/pkgconfig/ggml.pc")
endif()
file(REMOVE_RECURSE "${CURRENT_PACKAGES_DIR}/share/pkgconfig"
                    "${CURRENT_PACKAGES_DIR}/debug/share/pkgconfig")
vcpkg_fixup_pkgconfig()

file(REMOVE_RECURSE "${CURRENT_PACKAGES_DIR}/debug/include")
file(REMOVE_RECURSE "${CURRENT_PACKAGES_DIR}/debug/share")

set(VCPKG_POLICY_MISMATCHED_NUMBER_OF_BINARIES enabled)
if(QVAC_DESKTOP_DL_GPU AND VCPKG_TARGET_IS_WINDOWS)
    # The runtime-loaded backend DLLs are payload of a static-linkage port,
    # not linked libraries; without this the static-build post-build check
    # rejects them.
    set(VCPKG_POLICY_DLLS_IN_STATIC_LIBRARY enabled)
endif()

file(INSTALL "${CMAKE_CURRENT_LIST_DIR}/usage" DESTINATION "${CURRENT_PACKAGES_DIR}/share/${PORT}")
vcpkg_install_copyright(FILE_LIST "${SOURCE_PATH}/LICENSE")
