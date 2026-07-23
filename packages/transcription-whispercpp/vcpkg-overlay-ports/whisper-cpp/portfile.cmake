# whisper-cpp: pinned at tetherto/qvac-ext-lib-whisper.cpp@master
# post repo-reorg (QIP #94, PR stack #93/#95/#102): whisper now lives under
# third_party/whisper.cpp as an upstream git subtree with a declared QVAC
# delta (see PATCHES.md there). The GNUInstallDirs ordering patch this port
# used to carry is absorbed into that delta, so PATCHES is gone.
# This port moves together with parakeet-cpp and tts-cpp so all three registry
# ports source the same master commit and the same archive SHA512.
#
vcpkg_from_github(
  OUT_SOURCE_PATH SOURCE_PATH
  REPO tetherto/qvac-ext-lib-whisper.cpp
  REF 88b690c051666a63d6f5494a68596c4e785468ef
  SHA512 a1adf1fc953e4c8210e120fc2859aece34a0c738407a346dadaa4bc1762b3f6f6f65ddaceb5ee6d470f56e209ae1d6f49a671cc844f3dfdd8c8a46bf53b426f0
  HEAD_REF master
)

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
