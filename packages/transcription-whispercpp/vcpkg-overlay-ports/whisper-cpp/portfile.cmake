# whisper-cpp: pinned at tetherto/qvac-ext-lib-whisper.cpp@master
# cb91a378 (Pull latest from upstream whisper.cpp (v1.9.1) (#73)).
# This port moves together with parakeet-cpp and tts-cpp so all three registry
# ports source the same master commit and the same archive SHA512.
#
vcpkg_from_github(
  OUT_SOURCE_PATH SOURCE_PATH
  REPO tetherto/qvac-ext-lib-whisper.cpp
  REF 4dd6b2e82ef8f68e15a3c10c2f2e0b2351313ece
  SHA512 fedb5793c860ba688756e3ec1a7c816860581efeef78df5f4b72d96d9df7cc6a3d595e7959e6deb7e0ba663bbde6f3a5b073340186c8a55e573a53eda28ecb11
  HEAD_REF master
)

# Repo reorg (QIP #94): whisper now lives under third_party/whisper.cpp as a
# git subtree; the GNUInstallDirs ordering patch was absorbed into the
# subtree delta (third_party/whisper.cpp/PATCHES.md), so no PATCHES here.
set(SOURCE_PATH "${SOURCE_PATH}/third_party/whisper.cpp")

# whisper-cpp consumes the system-installed ggml provided by the `ggml-speech`
# port (same shape as the `parakeet-cpp` and `tts-cpp` ports). Backend
# selection, Android dynamic-backend packaging, Vulkan-Headers download,
# spirv-headers include shim, per-arch CPU variants and the
# libqvac-speech-ggml-* filename prefix are all owned by `ggml-speech`; this
# port only carries whisper-specific build options and links against the
# installed ggml via `find_package(ggml)` (gated by WHISPER_USE_SYSTEM_GGML).
#
# Per-feature wiring lives in vcpkg.json:
#   whisper-cpp[metal]  -> ggml-speech[metal]   (osx | ios)
#   whisper-cpp[vulkan] -> ggml-speech[vulkan]  (linux | windows | android)
#   whisper-cpp[opencl] -> ggml-speech[opencl]  (android)
# so consumers express the full GPU matrix declaratively.

vcpkg_cmake_configure(
  SOURCE_PATH "${SOURCE_PATH}"
  DISABLE_PARALLEL_CONFIGURE
  OPTIONS
    -DWHISPER_USE_SYSTEM_GGML=ON
    -DWHISPER_BUILD_TESTS=OFF
    -DWHISPER_BUILD_EXAMPLES=OFF
    -DWHISPER_BUILD_SERVER=OFF
    -DBUILD_SHARED_LIBS=OFF
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

# whisper-cpp itself produces no shared libraries when BUILD_SHARED_LIBS=OFF.
# The ggml backend .so files (Android dynamic-backend mode) are installed by
# the ggml-speech port into ${VCPKG_INSTALLED_DIR}/<triplet>/lib/, not by us.
if (VCPKG_LIBRARY_LINKAGE MATCHES "static")
  file(REMOVE_RECURSE "${CURRENT_PACKAGES_DIR}/bin")
  file(REMOVE_RECURSE "${CURRENT_PACKAGES_DIR}/debug/bin")
endif()

vcpkg_install_copyright(FILE_LIST "${SOURCE_PATH}/LICENSE")
