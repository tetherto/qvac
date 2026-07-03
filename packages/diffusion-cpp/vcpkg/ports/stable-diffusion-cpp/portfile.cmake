# stable-diffusion.cpp vcpkg overlay port
#
# Builds the stable-diffusion.cpp inference library and links against the
# system-installed ggml provided by the separate ggml overlay port.
#
# Pulls from tetherto/qvac-ext-stable-diffusion.cpp (branch 2026-06-04).
# REF is pinned to the PR head commit for reproducibility while the dependency
# PR is under review.
vcpkg_from_git(
    OUT_SOURCE_PATH SOURCE_PATH
    URL "https://github.com/tetherto/qvac-ext-stable-diffusion.cpp.git"
    REF 5cd1a79a71870c80dd18d1d7fb297567203c12a3
)

# QVAC diffusion-cpp does not expose upstream Lens/PiD model paths, but the
# upstream tokenizer bundle embeds their GPT-OSS and Gemma2 vocab assets into
# every static prebuild. Keep the function symbols for source compatibility and
# replace the heavy embedded blobs with runtime failures if those unsupported
# paths are ever exercised.
set(_QVAC_VOCAB_CPP "${SOURCE_PATH}/src/tokenizers/vocab/vocab.cpp")
file(READ "${_QVAC_VOCAB_CPP}" _qvac_vocab_cpp)
string(REPLACE "#include \"gemma2_merges.hpp\"\n" "" _qvac_vocab_cpp "${_qvac_vocab_cpp}")
string(REPLACE "#include \"gemma2_vocab.hpp\"\n" "" _qvac_vocab_cpp "${_qvac_vocab_cpp}")
string(REPLACE "#include \"gpt_oss_merges.hpp\"\n" "" _qvac_vocab_cpp "${_qvac_vocab_cpp}")
string(REPLACE "#include \"gpt_oss_vocab.hpp\"\n" "" _qvac_vocab_cpp "${_qvac_vocab_cpp}")
string(REPLACE "#include \"vocab.h\"\n" "#include \"vocab.h\"\n#include <stdexcept>\n" _qvac_vocab_cpp "${_qvac_vocab_cpp}")
string(REGEX REPLACE
    "std::string load_gemma2_merges\\(\\) \\{[^}]*\\}"
    "std::string load_gemma2_merges() { throw std::runtime_error(\"Gemma2 tokenizer is disabled in the QVAC diffusion-cpp build\"); }"
    _qvac_vocab_cpp "${_qvac_vocab_cpp}")
string(REGEX REPLACE
    "std::string load_gemma2_vocab_json\\(\\) \\{[^}]*\\}"
    "std::string load_gemma2_vocab_json() { throw std::runtime_error(\"Gemma2 tokenizer is disabled in the QVAC diffusion-cpp build\"); }"
    _qvac_vocab_cpp "${_qvac_vocab_cpp}")
string(REGEX REPLACE
    "std::string load_gpt_oss_merges\\(\\) \\{[^}]*\\}"
    "std::string load_gpt_oss_merges() { throw std::runtime_error(\"GPT-OSS tokenizer is disabled in the QVAC diffusion-cpp build\"); }"
    _qvac_vocab_cpp "${_qvac_vocab_cpp}")
string(REGEX REPLACE
    "std::string load_gpt_oss_vocab_json\\(\\) \\{[^}]*\\}"
    "std::string load_gpt_oss_vocab_json() { throw std::runtime_error(\"GPT-OSS tokenizer is disabled in the QVAC diffusion-cpp build\"); }"
    _qvac_vocab_cpp "${_qvac_vocab_cpp}")
file(WRITE "${_QVAC_VOCAB_CPP}" "${_qvac_vocab_cpp}")
unset(_qvac_vocab_cpp)

set(SD_FLASH_ATTN OFF)

if("flash-attn" IN_LIST FEATURES)
    set(SD_FLASH_ATTN ON)
endif()

# Only build Release; debug builds are not needed for the prebuild and can
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

set(VCPKG_POLICY_MISMATCHED_NUMBER_OF_BINARIES enabled)

file(INSTALL "${CMAKE_CURRENT_LIST_DIR}/usage" DESTINATION "${CURRENT_PACKAGES_DIR}/share/${PORT}")
vcpkg_install_copyright(FILE_LIST "${SOURCE_PATH}/LICENSE")
