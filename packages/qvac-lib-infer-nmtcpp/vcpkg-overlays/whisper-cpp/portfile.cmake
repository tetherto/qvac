set(VERSION "a8d002cfd879315632a579e73f0148d06959de36")

vcpkg_from_github(
  OUT_SOURCE_PATH SOURCE_PATH
  REPO ggml-org/whisper.cpp
  REF ${VERSION}
  SHA512 aea24debb836131d14d362ff78c6d12cfe2e82188340e69e71e6874a1fa51fa9405f2c03fe43888b1ff4183f4288bf64f07dd1106224b0108c3e0f844989a409
  HEAD_REF master
  PATCHES
    0001-fix-vcpkg-build.patch
    0002-fix-apple-silicon-cross-compile.patch
)

set(PLATFORM_OPTIONS)

if (VCPKG_TARGET_IS_ANDROID)
  list(APPEND PLATFORM_OPTIONS -DWHISPER_NO_AVX=ON -DWHISPER_NO_AVX2=ON -DWHISPER_NO_FMA=ON)
  # Disable Vulkan on Android to avoid libvulkan.so dependency
  list(APPEND PLATFORM_OPTIONS -DGGML_VULKAN=OFF)

  # Download Vulkan-Hpp C++ wrapper headers (not included in Android NDK)
  # Use Vulkan-Hpp 1.3.275 to match Android NDK's Vulkan 1.3.275
  message(STATUS "Downloading Vulkan-Hpp headers for Android build...")
  vcpkg_from_github(
    OUT_SOURCE_PATH VULKAN_HPP_PATH
    REPO KhronosGroup/Vulkan-Hpp
    REF v1.3.275
    SHA512 1b81cffea51d7da9a8729bc8d9a222b8f506f6a95a80fc82e95b0b1aa5bedb31c4493691ebd5c2e8be688338b63aee1afdf0ad9e9158118734806557b0eef50b
    HEAD_REF main
  )
  # Copy vulkan/ directory to build tree
  file(COPY "${VULKAN_HPP_PATH}/vulkan/"
       DESTINATION "${SOURCE_PATH}/ggml/src/ggml-vulkan/vulkan")
  # Add the directory to include path so #include <vulkan/vulkan.hpp> finds it
  list(APPEND PLATFORM_OPTIONS "-DCMAKE_CXX_FLAGS=-I${SOURCE_PATH}/ggml/src/ggml-vulkan")
endif()

vcpkg_cmake_configure(
  SOURCE_PATH "${SOURCE_PATH}"
  DISABLE_PARALLEL_CONFIGURE
  OPTIONS
    -DGGML_CCACHE=OFF
    -DGGML_OPENMP=OFF
    -DGGML_NATIVE=OFF
    -DWHISPER_BUILD_TESTS=OFF
    -DWHISPER_BUILD_EXAMPLES=OFF
    -DWHISPER_BUILD_SERVER=OFF
    -DBUILD_SHARED_LIBS=OFF
    -DGGML_BUILD_NUMBER=1
    ${PLATFORM_OPTIONS}
)

vcpkg_cmake_install()

vcpkg_cmake_config_fixup(
  PACKAGE_NAME whisper
  CONFIG_PATH share/whisper
)

vcpkg_fixup_pkgconfig()

vcpkg_copy_pdbs()

file(REMOVE_RECURSE "${CURRENT_PACKAGES_DIR}/debug/include")
file(REMOVE_RECURSE "${CURRENT_PACKAGES_DIR}/debug/share")

if (VCPKG_LIBRARY_LINKAGE MATCHES "static")
  file(REMOVE_RECURSE "${CURRENT_PACKAGES_DIR}/bin")
  file(REMOVE_RECURSE "${CURRENT_PACKAGES_DIR}/debug/bin")
endif()

vcpkg_install_copyright(FILE_LIST "${SOURCE_PATH}/LICENSE")
