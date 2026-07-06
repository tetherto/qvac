# TEMPORARY CI OVERLAY -- do not merge.
#
# Mirrors the registry tts-cpp port verbatim except the source fetch, which is
# repointed at the qvac-ext-lib-whisper.cpp PR #81 head commit (a723e25a,
# rebased onto master 1d9ca83b): converge T3 / S3Gen / Supertonic onto the
# shared sched_dispatch helper (per-op GPU->CPU fallback with ggml_status
# propagation) and rebuild Supertonic's dual-path graphs per scheduler pass --
# sched graphs are single-use for allocation, so the previous cached-graph
# reuse through the scheduler deterministically corrupted output on
# natural-sched backends (Adreno) after the first use per site.  Adreno output
# deliberately changes (gets fixed) with this pin.
# This overlay validates that branch on device-farm CI ahead of merge; drop it
# (the dir + the VCPKG_OVERLAY_PORTS line in ../../CMakeLists.txt) and bump the
# registry version>= once PR #81 merges and the registry port lands.

set(VCPKG_POLICY_MISMATCHED_NUMBER_OF_BINARIES enabled)
set(VCPKG_BUILD_TYPE release)

vcpkg_from_github(
    OUT_SOURCE_PATH WHISPER_CPP_SRC
    REPO tetherto/qvac-ext-lib-whisper.cpp
    REF a723e25a98e5646793c271cabb299d136e54910d
    SHA512 45507443256f20ee3c2b8108d490c36c2abfa078d103455c8c8a497114e4f3c7c73fc3cdc6fde41dd8067d1da879dfdd44d5df6e084a2673fb84db3e90e5ba2d
    HEAD_REF master
)

set(SOURCE_PATH "${WHISPER_CPP_SRC}/tts-cpp")
if (NOT EXISTS "${SOURCE_PATH}/CMakeLists.txt")
    message(FATAL_ERROR
        "tts-cpp: ${SOURCE_PATH}/CMakeLists.txt missing; the tts-cpp/ "
        "subfolder layout in qvac-ext-lib-whisper.cpp may have changed.")
endif()

vcpkg_check_features(OUT_FEATURE_OPTIONS FEATURE_OPTIONS
    FEATURES
        metal   GGML_METAL
        vulkan  GGML_VULKAN
        cuda    GGML_CUDA
        opencl  GGML_OPENCL
)

set(PLATFORM_OPTIONS)

if(NOT VCPKG_TARGET_IS_OSX)
    list(APPEND PLATFORM_OPTIONS
        -DGGML_BLAS=OFF
        -DGGML_ACCELERATE=OFF
        -DCMAKE_DISABLE_FIND_PACKAGE_BLAS=ON
    )
endif()

vcpkg_cmake_configure(
    SOURCE_PATH "${SOURCE_PATH}"
    DISABLE_PARALLEL_CONFIGURE
    OPTIONS
        -DTTS_CPP_BUILD_LIBRARY=ON
        -DTTS_CPP_BUILD_SHARED=OFF
        -DTTS_CPP_BUILD_EXECUTABLES=OFF
        -DTTS_CPP_BUILD_TESTS=OFF
        -DTTS_CPP_INSTALL=ON
        -DTTS_CPP_USE_SYSTEM_GGML=ON
        -DBUILD_SHARED_LIBS=OFF
        -DGGML_NATIVE=OFF
        -DGGML_OPENMP=OFF
        -DTTS_CPP_OPENMP=OFF
        -DGGML_CCACHE=OFF
        -DTTS_CPP_CCACHE=OFF
        ${FEATURE_OPTIONS}
        ${PLATFORM_OPTIONS}
)

vcpkg_cmake_install()

vcpkg_cmake_config_fixup(PACKAGE_NAME tts-cpp CONFIG_PATH share/tts-cpp)

file(REMOVE_RECURSE "${CURRENT_PACKAGES_DIR}/debug/include")
file(REMOVE_RECURSE "${CURRENT_PACKAGES_DIR}/debug/share")

if (VCPKG_LIBRARY_LINKAGE MATCHES "static")
    file(REMOVE_RECURSE "${CURRENT_PACKAGES_DIR}/bin")
    file(REMOVE_RECURSE "${CURRENT_PACKAGES_DIR}/debug/bin")
endif()

vcpkg_install_copyright(FILE_LIST "${SOURCE_PATH}/LICENSE")
