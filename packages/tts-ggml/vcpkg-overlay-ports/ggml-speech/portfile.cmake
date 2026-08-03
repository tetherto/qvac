# ggml-speech: tetherto/qvac-ext-ggml@speech.
#
# THROWAWAY CI OVERLAY — do not merge. REF is the tip of the unmerged
# cosyvoice-opencl branch (qvac-ext-ggml PR #50): the Adreno fused IM2COL→GEMM
# path no longer requires M to be a multiple of 4 — it pads A's row stride and
# takes that stride separately from dst's. A generic backend fix.
vcpkg_from_github(
    OUT_SOURCE_PATH SOURCE_PATH
    REPO tetherto/qvac-ext-ggml
    REF 5d204ffd8823a1418e76f41e8c451195a178a732
    SHA512 ad1948a12d3e65d32d269f451d7301a0c3136899077304f8e26673b4259d167c4feef43505c5c916679f4a419dabb29f62438b4a2e20afc7c2c3db3f2f5e0117
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

if("cuda" IN_LIST FEATURES)
    set(GGML_CUDA ON)
    find_program(NVCC_EXECUTABLE nvcc
        PATHS /usr/local/cuda/bin /usr/local/cuda-12.8/bin
        NO_DEFAULT_PATH
    )
    if(NOT NVCC_EXECUTABLE)
        find_program(NVCC_EXECUTABLE nvcc REQUIRED)
    endif()
    set(GGML_CUDA_COMPILER_OPTION "-DCMAKE_CUDA_COMPILER=${NVCC_EXECUTABLE}")
    message(STATUS "CUDA compiler: ${NVCC_EXECUTABLE}")
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

# Hybrid Android backend mode: GPU backends as MODULE .so loaded at runtime
# via dlopen, CPU built as per-arch MODULE .so variants (one per ARMv8.0/
# 8.2/8.6/9.0/9.2 feature tier) also loaded at runtime via dlopen. The
# downstream addon installs the resulting libqvac-speech-ggml-cpu-android_armv*
# .so files alongside the .bare binary; the per-variant scoring in
# ggml-cpu's `ggml_backend_cpu_aarch64_score` then picks the highest tier
# the running device supports at first use. Pairs with the speech-branch
# `ggml-backend: android per-arch CPU variant dlopen fallback` patch
# (commit 9562ed04) so the variant lookup also succeeds when the consumer
# APK keeps native .so files compressed (AGP `useLegacyPackaging=false`).
if(VCPKG_TARGET_IS_ANDROID)
    list(APPEND PLATFORM_OPTIONS
        -DGGML_BACKEND_DL=ON
        -DGGML_CPU_ALL_VARIANTS=ON
        -DGGML_CPU_REPACK=ON
        -DGGML_VULKAN_DISABLE_COOPMAT=ON
        -DGGML_VULKAN_DISABLE_COOPMAT2=ON
    )
endif()

# Desktop aarch64 Linux: same per-arch CPU-variant packaging as Android.
# This build is not GGML_NATIVE and passes no -march override, so a
# single-variant CPU backend lands on the compiler's plain armv8-a
# baseline: the dotprod/fp16/i8mm ARM kernels (incl. the repack GEMM
# kernels in ggml-cpu/arch/arm/repack.cpp) are compiled out and both
# f16 and quantized (q4_0/q8_0) GEMMs stay on the slowest generic
# paths. GGML_CPU_ALL_VARIANTS builds one MODULE .so per ARMv8.x/9.x
# feature tier and scores them against the running CPU at first use,
# so the prebuild stays SIGILL-safe on any aarch64 host. The speech
# addons stage lib/libqvac-speech-ggml-*.so next to their .bare and
# forward backendsDir to ggml_backend_load_all_from_path(), same as
# Android. Verified on the Parakeet + Whisper RTF benchmarks (qvac
# runs 29243365879 / 29333221534): parakeet tdt q4_0 mean RTF
# 0.2285 -> 0.0612, whisper base f16 0.3316 -> 0.0970.
set(QVAC_LINUX_ARM64_DL_CPU OFF)
if(VCPKG_TARGET_IS_LINUX AND VCPKG_TARGET_ARCHITECTURE STREQUAL "arm64")
    set(QVAC_LINUX_ARM64_DL_CPU ON)
    list(APPEND PLATFORM_OPTIONS
        -DGGML_BACKEND_DL=ON
        -DGGML_CPU_ALL_VARIANTS=ON
        -DGGML_CPU_REPACK=ON
        # The dlopen'd MODULE backends must not carry shared-library
        # dependencies the host machine doesn't ship. The qvac linux
        # triplets compile with clang -stdlib=libc++ but only the final
        # addon binary links libc++ statically; a module with NEEDED
        # libc++.so.1 / libc++abi.so.1 entries fails to dlopen on a
        # stock host (no libc++ runtime package) and the registry
        # loader skips it *silently* -- the CPU backend then simply
        # never registers ("no CPU device registered"). Link the C++
        # runtime statically into the modules instead, matching the
        # addon convention. Composed with the triplet's own
        # VCPKG_LINKER_FLAGS because a bare -DCMAKE_MODULE_LINKER_FLAGS
        # would override vcpkg's *_INIT seeding and drop the triplet's
        # -stdlib=libc++ at link time (under gcc triplets this composes
        # to plain -static-libstdc++, which is equally valid).
        "-DCMAKE_MODULE_LINKER_FLAGS=${VCPKG_LINKER_FLAGS} -static-libstdc++"
    )
endif()

# The v0.10.2 ggml sync introduces an unconditional
# `#include <spirv/unified1/spirv.hpp>` in src/ggml-vulkan/ggml-vulkan.cpp,
# but the upstream ggml-vulkan CMakeLists.txt never finds spirv-headers nor
# wires its include dir into the ggml-vulkan target. Apply a small patch
# so it does (and depend on spirv-headers in vcpkg.json's vulkan feature).
# TODO: push the equivalent fix upstream and drop this patch.
if("vulkan" IN_LIST FEATURES)
    vcpkg_apply_patches(
        SOURCE_PATH "${SOURCE_PATH}"
        PATCHES
            "${CMAKE_CURRENT_LIST_DIR}/patches/0001-ggml-vulkan-find-spirv-headers.patch"
    )
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

# Desktop Linux MODULE backend pickup. ggml's own install() places the
# MODULE backends in bin/ (CMAKE_INSTALL_BINDIR) and -- unlike Android,
# where CMake never versions module filenames -- as versioned files
# (libqvac-speech-ggml-cpu-armv8.2_1.so.<ver>) plus unversioned .so
# symlinks. Two problems with leaving them there: the runtime loader
# only matches the exact `.so` extension, and the speech addons stage
# backends by file(INSTALL)-ing a glob of lib/libqvac-speech-ggml-*.so,
# which would copy a symlink without its target. Dereference each
# unversioned name onto its real file, publish plain .so files in lib/,
# and drop bin/ (static triplets must not ship a bin/ dir anyway).
if(QVAC_LINUX_ARM64_DL_CPU)
    foreach(_cfg "" "/debug")
        file(GLOB _backend_mods
            "${CURRENT_PACKAGES_DIR}${_cfg}/bin/libqvac-speech-ggml-*.so")
        foreach(_mod IN LISTS _backend_mods)
            get_filename_component(_mod_name "${_mod}" NAME)
            file(REAL_PATH "${_mod}" _mod_real)
            file(COPY_FILE "${_mod_real}"
                 "${CURRENT_PACKAGES_DIR}${_cfg}/lib/${_mod_name}")
        endforeach()
        file(REMOVE_RECURSE "${CURRENT_PACKAGES_DIR}${_cfg}/bin")
        # Do not ship the SVE-bearing CPU variants. ggml's SVE code
        # paths are drastically slower than the NEON dotprod/fp16 paths
        # on the 128-bit-vector cores that make up the desktop
        # arm64-linux fleet (Neoverse-N2 runners; Apple VMs and
        # Snapdragon X have no SVE at all): whisper base q8_0 RTF
        # 0.2224 via armv8.6_2 (SVE) vs 0.0626 via armv8.2_2 (no SVE),
        # f16 0.2586 vs 0.0938 (qvac A/B runs 29328745233 /
        # 29332248742) -- and the runtime score would pick the SVE
        # tiers on SVE hardware. Parakeet is within 3% either way (its
        # hot GEMMs use the NEON repack kernels). Revisit when the
        # speech branch grows an SVE-free i8mm tier (the Android
        # variant list has one) or VL-aware scoring.
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

file(INSTALL "${CMAKE_CURRENT_LIST_DIR}/usage" DESTINATION "${CURRENT_PACKAGES_DIR}/share/${PORT}")
vcpkg_install_copyright(FILE_LIST "${SOURCE_PATH}/LICENSE")
