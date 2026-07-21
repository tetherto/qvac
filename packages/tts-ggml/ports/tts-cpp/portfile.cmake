# LOCAL OVERLAY of the tts-cpp port.
#
# Builds tts-cpp from a working-tree checkout of qvac-ext-lib-whisper.cpp
# instead of the registry-pinned GitHub tarball, so the not-yet-published
# CosyVoice3 engine (tts-cpp/include/tts-cpp/cosyvoice/engine.h + the shared
# pipeline) is available to the @qvac/tts-ggml addon build.
#
# Source dir precedence:
#   1. $ENV{TTS_CPP_LOCAL_SOURCE}                (explicit override)
#   2. <this-registry>/../../../../qvac-ext-lib-whisper.cpp/tts-cpp   (sibling repo)
#
# Everything below (configure options, features, install) mirrors the registry
# port so the produced package is drop-in identical apart from the source.
# Remove this overlay once the CosyVoice3 pin lands in qvac-registry-vcpkg.

set(VCPKG_POLICY_MISMATCHED_NUMBER_OF_BINARIES enabled)
set(VCPKG_BUILD_TYPE release)

if(DEFINED ENV{TTS_CPP_LOCAL_SOURCE} AND NOT "$ENV{TTS_CPP_LOCAL_SOURCE}" STREQUAL "")
    set(SOURCE_PATH "$ENV{TTS_CPP_LOCAL_SOURCE}")
else()
    # ports/tts-cpp -> ports -> tts-ggml -> packages -> qvac -> v
    get_filename_component(_v_root "${CMAKE_CURRENT_LIST_DIR}/../../../../.." ABSOLUTE)
    set(SOURCE_PATH "${_v_root}/qvac-ext-lib-whisper.cpp/tts-cpp")
endif()

message(STATUS "tts-cpp OVERLAY: building from local source ${SOURCE_PATH}")

if(NOT EXISTS "${SOURCE_PATH}/CMakeLists.txt")
    message(FATAL_ERROR
        "tts-cpp overlay: ${SOURCE_PATH}/CMakeLists.txt missing. Set "
        "TTS_CPP_LOCAL_SOURCE to your local qvac-ext-lib-whisper.cpp/tts-cpp dir.")
endif()
if(NOT EXISTS "${SOURCE_PATH}/include/tts-cpp/cosyvoice/engine.h")
    message(FATAL_ERROR
        "tts-cpp overlay: ${SOURCE_PATH} has no cosyvoice/engine.h -- point "
        "TTS_CPP_LOCAL_SOURCE at the branch with the CosyVoice3 engine.")
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

if(VCPKG_LIBRARY_LINKAGE MATCHES "static")
    file(REMOVE_RECURSE "${CURRENT_PACKAGES_DIR}/bin")
    file(REMOVE_RECURSE "${CURRENT_PACKAGES_DIR}/debug/bin")
endif()

vcpkg_install_copyright(FILE_LIST "${SOURCE_PATH}/LICENSE")
