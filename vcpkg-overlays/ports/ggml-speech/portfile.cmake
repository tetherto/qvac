vcpkg_from_github(
    OUT_SOURCE_PATH SOURCE_PATH
    REPO tetherto/qvac-ext-ggml
    REF 380c5f9f3e1811dfd88adeb1c19ab887bcf8ab3e
    SHA512 287656a82b0eab1606ad8962095edfe44c1b549587995777c75bfc67a77fb36fb8ce65b1864438607d804181f8241960a9d7d9c65a269665e8db5dd945fe2873
    HEAD_REF speech
)

set(GGML_METAL  OFF)
set(GGML_VULKAN OFF)
set(GGML_CUDA   OFF)
set(GGML_OPENCL OFF)
set(GGML_WEBGPU OFF)
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

# WebGPU rides on the dawn port from the official registry (Dawn built from
# source under the same triplet, so a clang/libc++ triplet never links a
# libstdc++-built Dawn). ggml-webgpu embeds its WGSL shaders with a Python
# script at configure time, hence the explicit interpreter.
set(GGML_WEBGPU_OPTIONS "")
if("webgpu" IN_LIST FEATURES)
    set(GGML_WEBGPU ON)
    vcpkg_find_acquire_program(PYTHON3)
    list(APPEND GGML_WEBGPU_OPTIONS "-DPython3_EXECUTABLE=${PYTHON3}")
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

# nvcc before CUDA 13.4 cannot compile libc++ host code. Keep the CUDA
# module and its private ggml-base on libstdc++, linked statically and hidden
# behind the loader's C entry points. Other backends retain the triplet STL.
if(VCPKG_TARGET_IS_LINUX AND GGML_CUDA)
    list(APPEND PLATFORM_OPTIONS
        "-DCMAKE_PROJECT_ggml_INCLUDE=${CMAKE_CURRENT_LIST_DIR}/linux-cuda-runtime.cmake")
endif()

# tinyBLAS GEMM for the F16 and Q8_0 weights: measured 1.2x on x86 (7950X3D,
# Ryzen AI MAX+ 395) and 1.7x at F16 on Apple silicon for Parakeet; other
# targets are unmeasured and keep the plain ggml-cpu path.
set(GGML_LLAMAFILE OFF)
if((VCPKG_TARGET_IS_LINUX AND VCPKG_TARGET_ARCHITECTURE STREQUAL "x64")
        OR (VCPKG_TARGET_IS_OSX AND VCPKG_TARGET_ARCHITECTURE STREQUAL "arm64"))
    set(GGML_LLAMAFILE ON)
endif()

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
#
# - Desktop x64 Linux without CUDA: the same per-arch CPU-variant packaging.
#   A static non-native build is AVX2-only and leaves 11 to 14 percent of
#   Parakeet encoder time on AVX-512 hosts.
set(QVAC_LINUX_ARM64_DL_CPU OFF)
if(VCPKG_TARGET_IS_LINUX AND VCPKG_TARGET_ARCHITECTURE STREQUAL "arm64")
    set(QVAC_LINUX_ARM64_DL_CPU ON)
endif()
set(QVAC_DESKTOP_DL_GPU OFF)
if(VCPKG_TARGET_ARCHITECTURE STREQUAL "x64"
        AND (VCPKG_TARGET_IS_LINUX OR (VCPKG_TARGET_IS_WINDOWS AND "cuda" IN_LIST FEATURES)))
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

set(GGML_SPEECH_BUILD_DIR_SUFFIXES rel)
if(NOT VCPKG_BUILD_TYPE)
    list(APPEND GGML_SPEECH_BUILD_DIR_SUFFIXES dbg)
endif()

function(ggml_speech_refuse_hexagon_cache cmake_cache)
    file(STRINGS "${cmake_cache}" hexagon_entry REGEX "^GGML_HEXAGON:[A-Z]+=")
    string(REGEX MATCH "^GGML_HEXAGON:[A-Z]+=(.*)$" hexagon_match "${hexagon_entry}")
    set(hexagon_enabled "${CMAKE_MATCH_1}")
    if(hexagon_enabled)
        message(FATAL_ERROR
            "ggml-speech: ${cmake_cache} has GGML_HEXAGON=${hexagon_enabled}. The Hexagon "
            "backend and its DSP skeletons (libggml-htp-v*.so) are not released with the "
            "speech addons, so this port must not build or ship them. Remove the "
            "GGML_HEXAGON override, for example from the triplet's "
            "VCPKG_CMAKE_CONFIGURE_OPTIONS.")
    endif()
endfunction()

function(ggml_speech_refuse_hexagon_builds)
    foreach(build_dir_suffix IN LISTS GGML_SPEECH_BUILD_DIR_SUFFIXES)
        ggml_speech_refuse_hexagon_cache(
            "${CURRENT_BUILDTREES_DIR}/${TARGET_TRIPLET}-${build_dir_suffix}/CMakeCache.txt")
    endforeach()
endfunction()

vcpkg_cmake_configure(
    SOURCE_PATH "${SOURCE_PATH}"
    OPTIONS
        -DBUILD_SHARED_LIBS=OFF
        -DGGML_NATIVE=OFF
        -DGGML_CCACHE=OFF
        -DGGML_OPENMP=OFF
        -DGGML_LLAMAFILE=${GGML_LLAMAFILE}
        -DGGML_BUILD_TESTS=OFF
        -DGGML_BUILD_EXAMPLES=OFF
        -DGGML_METAL=${GGML_METAL}
        -DGGML_VULKAN=${GGML_VULKAN}
        -DGGML_CUDA=${GGML_CUDA}
        -DGGML_OPENCL=${GGML_OPENCL}
        -DGGML_WEBGPU=${GGML_WEBGPU}
        ${GGML_WEBGPU_OPTIONS}
        -DGGML_HEXAGON=OFF
        -DGGML_METAL_FUSE_MV_BIAS=${GGML_METAL_FUSE_MV_BIAS}
        -DGGML_LIB_OUTPUT_PREFIX=qvac-speech-
        -DGGML_VULKAN_STRIP_SHADER_PAYLOADS=ON
        ${GGML_CUDA_COMPILER_OPTION}
        ${GGML_CUDA_ARCHITECTURES_OPTION}
        ${GGML_CUDA_GRAPHS_OPTION}
        ${PLATFORM_OPTIONS}
)

ggml_speech_refuse_hexagon_builds()

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

# Ship only the NEON dotprod/fp16 CPU variants on arm64-linux. ggml no
# longer builds SVE tiers there; the two tiers above armv8.2_2 are now
# SVE-free (armv8.6_1 adds i8mm, armv9.2_1 adds SME) but have not been
# measured on the desktop arm64-linux fleet, and the runtime score would
# pick them where the hardware allows. Ship them once they are measured.
if(QVAC_LINUX_ARM64_DL_CPU)
    foreach(_cfg "" "/debug")
        foreach(_unmeasured_tier armv8.6_1 armv9.2_1)
            file(REMOVE
                "${CURRENT_PACKAGES_DIR}${_cfg}/lib/libqvac-speech-ggml-cpu-${_unmeasured_tier}.so")
        endforeach()
    endforeach()
endif()

# Check the actual staged payload after desktop modules have been copied
# from bin/ to lib/, including debug modules when that configuration is built.
if(VCPKG_TARGET_IS_LINUX AND QVAC_DESKTOP_DL)
    include("${CMAKE_CURRENT_LIST_DIR}/qvac-check-cxx-runtime.cmake")
    file(GLOB QVAC_MODULES
        "${CURRENT_PACKAGES_DIR}/lib/*.so"
        "${CURRENT_PACKAGES_DIR}/debug/lib/*.so")
    qvac_check_cxx_runtime(${QVAC_MODULES})
endif()

vcpkg_cmake_config_fixup(PACKAGE_NAME ggml CONFIG_PATH share/ggml)

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
