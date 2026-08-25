# Local overlay port, not for merge: identical to the registry's speech-cpp
# except the pin moves onto the Strix ACE-Step optimization branch (HEAD_REF).
#
# speech-cpp: umbrella port over tetherto/qvac-ext-lib-whisper.cpp (QIP #94,
# Ticket 4). One source pin, per-engine features:
#
#   speech-cpp[whisper]   -> third_party/whisper.cpp (package `whisper`)
#   speech-cpp[parakeet]  -> engines/parakeet        (package `qvac-parakeet`)
#   speech-cpp[tts]       -> engines/tts             (package `tts-cpp`)
#   speech-cpp[audiogen]  -> engines/audiogen        (package `audiogen-cpp`)
#
# The repo-root CMakeLists.txt is the superbuild this port drives: it resolves
# ONE system ggml (find_package(ggml) from the ggml-speech port) and hands it
# to every enabled engine, so the whole stack shares a single ggml pin — the
# ggml/ tree vendored inside the whisper subtree is never compiled. Backend
# selection (metal / vulkan / opencl / cuda) is therefore expressed purely as
# ggml-speech features in vcpkg.json; the GGML_* flags passed below only steer
# engine-side gating (e.g. which GPU paths the engines consider validated).
#
# Upstream whisper.cpp v1.9.1+ ships its own C-API `parakeet` (lib/libparakeet.*,
# lib/cmake/parakeet/, parakeet.pc) which collides with engines/parakeet. The
# umbrella forces WHISPER_BUILD_PARAKEET=OFF, so with [whisper,parakeet] enabled
# only OUR parakeet is built and installed — under the qvac-parakeet namespace
# (find_package(qvac-parakeet) + qvac::parakeet) — and upstream's is neither
# built nor installed. No file-ownership clash, no wasted build.
#
# The REF below is the single source pin for every engine. It replaced the
# standalone whisper-cpp / parakeet-cpp / tts-cpp / audiogen-cpp ports, which
# were removed from this registry once every consumer had migrated.

set(VCPKG_POLICY_MISMATCHED_NUMBER_OF_BINARIES enabled)
set(VCPKG_BUILD_TYPE release)

vcpkg_from_github(
    OUT_SOURCE_PATH SOURCE_PATH
    REPO tetherto/qvac-ext-lib-whisper.cpp
    REF b91ac4f927e1ae447b16bfd1bc4e14b2530c1aee
    SHA512 c01f39387c0939c503db76c753a2629cac68b9747a6eabfbb3e7bcdeba8b2e6bc0b9421b02d763575312e86b64187ff7665441f5d43c086a2050d48a7520f1aa
    HEAD_REF QVAC-24013/strix-acestep-opt
)

if (NOT EXISTS "${SOURCE_PATH}/CMakeLists.txt")
    message(FATAL_ERROR
        "speech-cpp: ${SOURCE_PATH}/CMakeLists.txt missing; the umbrella "
        "CMakeLists.txt at the qvac-ext-lib-whisper.cpp repo root may have moved.")
endif()

# Engine features, each mapped to its SPEECH_BUILD_<ENGINE> superbuild gate.
# The plain variables (not vcpkg_check_features) are needed again below for
# the per-engine vcpkg_cmake_config_fixup guards. Adding a future engine
# (e.g. qwen-asr) means extending this list plus its fixup below.
set(SPEECH_ENGINE_FEATURES whisper parakeet tts audiogen)

set(SPEECH_ENABLED_ENGINES "")
foreach(SPEECH_ENGINE IN LISTS SPEECH_ENGINE_FEATURES)
    string(TOUPPER "${SPEECH_ENGINE}" SPEECH_ENGINE_UPPER)
    set(SPEECH_BUILD_${SPEECH_ENGINE_UPPER} OFF)
    if("${SPEECH_ENGINE}" IN_LIST FEATURES)
        set(SPEECH_BUILD_${SPEECH_ENGINE_UPPER} ON)
        list(APPEND SPEECH_ENABLED_ENGINES "${SPEECH_ENGINE}")
    endif()
endforeach()

# Unreachable through a default install (the whisper feature is a default);
# guards a manifest that sets default-features false and picks only backends.
if (NOT SPEECH_ENABLED_ENGINES)
    list(JOIN SPEECH_ENGINE_FEATURES ", " SPEECH_ENGINE_FEATURE_LIST)
    message(FATAL_ERROR
        "speech-cpp: no engine selected. Enable at least one of the engine "
        "features: ${SPEECH_ENGINE_FEATURE_LIST}.")
endif()

# Engine-side GPU gating (the actual backends are compiled into ggml-speech;
# see the header comment).
vcpkg_check_features(OUT_FEATURE_OPTIONS FEATURE_OPTIONS
    FEATURES
        metal   GGML_METAL
        vulkan  GGML_VULKAN
        opencl  GGML_OPENCL
        cuda    GGML_CUDA
        coreml  PARAKEET_COREML
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
        -DSPEECH_BUILD_WHISPER=${SPEECH_BUILD_WHISPER}
        -DSPEECH_BUILD_PARAKEET=${SPEECH_BUILD_PARAKEET}
        -DSPEECH_BUILD_TTS=${SPEECH_BUILD_TTS}
        -DSPEECH_BUILD_AUDIOGEN=${SPEECH_BUILD_AUDIOGEN}
        -DSPEECH_BUILD_TESTS=OFF
        -DSPEECH_BUILD_EXECUTABLES=OFF
        -DBUILD_SHARED_LIBS=OFF
        # One shared system ggml. The superbuild already forces these (whisper
        # via CACHE FORCE; parakeet via set(); tts / audiogen default ON), but
        # the whole shared-pin premise rests on them, so pass them defensively
        # too — harmless when redundant, and a vendored-ggml build can never
        # slip in silently if an upstream default changes.
        -DWHISPER_USE_SYSTEM_GGML=ON
        -DPARAKEET_USE_SYSTEM_GGML=ON
        -DTTS_CPP_USE_SYSTEM_GGML=ON
        -DAUDIOGEN_USE_SYSTEM_GGML=ON
        # whisper-specific (the umbrella owns WHISPER_BUILD_TESTS/EXAMPLES and
        # WHISPER_BUILD_PARAKEET=OFF itself)
        -DWHISPER_BUILD_SERVER=OFF
        # parakeet-specific
        -DPARAKEET_BUILD_LIBRARY=ON
        -DPARAKEET_INSTALL=ON
        -DPARAKEET_OPENMP=OFF
        -DPARAKEET_CCACHE=OFF
        # tts-specific
        -DTTS_CPP_BUILD_LIBRARY=ON
        -DTTS_CPP_BUILD_SHARED=OFF
        -DTTS_CPP_INSTALL=ON
        -DTTS_CPP_OPENMP=OFF
        -DTTS_CPP_CCACHE=OFF
        # audiogen-specific
        -DAUDIOGEN_BUILD_LIBRARY=ON
        -DAUDIOGEN_INSTALL=ON
        -DAUDIOGEN_CCACHE=OFF
        # shared ggml-side knobs the engines forward
        -DGGML_NATIVE=OFF
        -DGGML_OPENMP=OFF
        -DGGML_CCACHE=OFF
        ${FEATURE_OPTIONS}
        ${PLATFORM_OPTIONS}
)

vcpkg_cmake_install()

# One config-fixup per enabled engine, each under its own package name. There
# is no bin/ payload to relocate for any of them (the old standalone
# parakeet-cpp PARAKEET_BIN_DIR/bin handling is dead and intentionally not
# carried over): executables are off and every engine builds static.
if (SPEECH_BUILD_WHISPER)
    vcpkg_cmake_config_fixup(PACKAGE_NAME whisper CONFIG_PATH share/whisper)
endif()
if (SPEECH_BUILD_PARAKEET)
    vcpkg_cmake_config_fixup(PACKAGE_NAME qvac-parakeet CONFIG_PATH lib/cmake/qvac-parakeet)
endif()
if (SPEECH_BUILD_TTS)
    vcpkg_cmake_config_fixup(PACKAGE_NAME tts-cpp CONFIG_PATH share/tts-cpp)
    # tts-cpp links mecab (Chatterbox MTL Japanese) and its exported link
    # interface carries mecab::mecab, but the generated tts-cppConfig.cmake
    # only declares the ggml dependency — a plain find_package(tts-cpp) fails
    # with "mecab::mecab ... target was not found". Declare it where the
    # engine's config generation should (engine follow-up); until then a bare
    # find_package(tts-cpp CONFIG) would not be consumable, which this port
    # guarantees.
    set(SPEECH_TTS_CONFIG "${CURRENT_PACKAGES_DIR}/share/tts-cpp/tts-cppConfig.cmake")
    file(READ "${SPEECH_TTS_CONFIG}" SPEECH_TTS_CONFIG_CONTENTS)
    if (SPEECH_TTS_CONFIG_CONTENTS MATCHES "find_dependency\\(ggml CONFIG\\)"
        AND NOT SPEECH_TTS_CONFIG_CONTENTS MATCHES "find_dependency\\(mecab")
        string(REPLACE
            "find_dependency(ggml CONFIG)"
            "find_dependency(ggml CONFIG)\nfind_dependency(mecab CONFIG)"
            SPEECH_TTS_CONFIG_CONTENTS "${SPEECH_TTS_CONFIG_CONTENTS}")
        file(WRITE "${SPEECH_TTS_CONFIG}" "${SPEECH_TTS_CONFIG_CONTENTS}")
    endif()
endif()
if (SPEECH_BUILD_AUDIOGEN)
    vcpkg_cmake_config_fixup(PACKAGE_NAME audiogen-cpp CONFIG_PATH share/audiogen-cpp)
endif()

# The engines' generated .pc files carry absolute -L/-I paths derived from the
# resolved location of the imported ggml target, and CMake's spelling of that
# path can differ from vcpkg's (macOS: /tmp vs /private/tmp), so
# vcpkg_fixup_pkgconfig()'s exact-string rewrite can silently miss. Normalise
# by meaning: rewrite any absolute -L/-I whose realpath lands inside the
# install prefix to the ${prefix}-relative form. (Same fix as the standalone
# parakeet-cpp port; see the discussion there.)
get_filename_component(SPEECH_INSTALLED_REALPATH "${CURRENT_INSTALLED_DIR}" REALPATH)

function(speech_relativize_pc pc_file)
    if (NOT EXISTS "${pc_file}")
        return()
    endif()
    file(READ "${pc_file}" contents)
    string(REGEX MATCHALL "-[LI][^ \t\r\n\"]+" tokens "${contents}")
    foreach (token IN LISTS tokens)
        string(SUBSTRING "${token}" 0 2 flag)
        string(SUBSTRING "${token}" 2 -1 dir)
        if (NOT IS_ABSOLUTE "${dir}")
            continue()
        endif()
        get_filename_component(dir_real "${dir}" REALPATH)
        # Only touch paths inside our own prefix; a genuinely external dep
        # (e.g. a system OpenMP runtime) must keep its absolute path.
        string(FIND "${dir_real}" "${SPEECH_INSTALLED_REALPATH}/" hit)
        if (NOT hit EQUAL 0)
            continue()
        endif()
        string(LENGTH "${SPEECH_INSTALLED_REALPATH}/" prefix_len)
        string(SUBSTRING "${dir_real}" ${prefix_len} -1 rel)
        string(REPLACE "${token}" "${flag}\${prefix}/${rel}" contents "${contents}")
    endforeach()
    file(WRITE "${pc_file}" "${contents}")
endfunction()

file(GLOB SPEECH_PC_FILES
    "${CURRENT_PACKAGES_DIR}/lib/pkgconfig/*.pc"
    "${CURRENT_PACKAGES_DIR}/debug/lib/pkgconfig/*.pc")
foreach (SPEECH_PC_FILE IN LISTS SPEECH_PC_FILES)
    speech_relativize_pc("${SPEECH_PC_FILE}")
endforeach()

vcpkg_fixup_pkgconfig()

# Guard the outcome by meaning, not by spelling: after the rewrites no -L/-I in
# a shipped .pc may still resolve into this machine's install/package/build
# trees, or the cached binary would not be relocatable.
file(GLOB SPEECH_PC_FILES "${CURRENT_PACKAGES_DIR}/lib/pkgconfig/*.pc")
foreach (SPEECH_PC_FILE IN LISTS SPEECH_PC_FILES)
    file(READ "${SPEECH_PC_FILE}" SPEECH_PC_CONTENTS)
    string(REGEX MATCHALL "-[LI][^ \t\r\n\"]+" SPEECH_PC_TOKENS "${SPEECH_PC_CONTENTS}")
    foreach (SPEECH_PC_TOKEN IN LISTS SPEECH_PC_TOKENS)
        string(SUBSTRING "${SPEECH_PC_TOKEN}" 2 -1 SPEECH_PC_DIR)
        if (NOT IS_ABSOLUTE "${SPEECH_PC_DIR}")
            continue()
        endif()
        get_filename_component(SPEECH_PC_DIR_REAL "${SPEECH_PC_DIR}" REALPATH)
        foreach (SPEECH_TREE
                 "${SPEECH_INSTALLED_REALPATH}" "${CURRENT_PACKAGES_DIR}" "${CURRENT_BUILDTREES_DIR}")
            get_filename_component(SPEECH_TREE_REAL "${SPEECH_TREE}" REALPATH)
            string(FIND "${SPEECH_PC_DIR_REAL}" "${SPEECH_TREE_REAL}" SPEECH_TREE_HIT)
            if (SPEECH_TREE_HIT EQUAL 0)
                message(FATAL_ERROR
                    "speech-cpp: ${SPEECH_PC_FILE} still contains '${SPEECH_PC_TOKEN}', which "
                    "resolves inside ${SPEECH_TREE_REAL}. The packaged .pc would not be "
                    "relocatable and would break consumers restoring this package from the "
                    "binary cache.")
            endif()
        endforeach()
    endforeach()
endforeach()

# Post-build guard for acceptance criterion 2: upstream whisper.cpp's bundled
# parakeet must never ship from this port.
foreach (SPEECH_FORBIDDEN
         "lib/cmake/parakeet"
         "lib/pkgconfig/parakeet.pc"
         "include/parakeet.h")
    if (EXISTS "${CURRENT_PACKAGES_DIR}/${SPEECH_FORBIDDEN}")
        message(FATAL_ERROR
            "speech-cpp: ${SPEECH_FORBIDDEN} was installed — upstream whisper.cpp's "
            "bundled parakeet leaked past the WHISPER_BUILD_PARAKEET=OFF gate and "
            "would collide with engines/parakeet's qvac-parakeet package.")
    endif()
endforeach()
file(GLOB SPEECH_UPSTREAM_PARAKEET_LIBS "${CURRENT_PACKAGES_DIR}/lib/*parakeet*")
foreach (SPEECH_LIB IN LISTS SPEECH_UPSTREAM_PARAKEET_LIBS)
    get_filename_component(SPEECH_LIB_NAME "${SPEECH_LIB}" NAME)
    if (NOT SPEECH_LIB_NAME MATCHES "qvac-parakeet")
        message(FATAL_ERROR
            "speech-cpp: unexpected parakeet artifact ${SPEECH_LIB_NAME} in lib/ — "
            "only libqvac-parakeet.* (from engines/parakeet) may be installed.")
    endif()
endforeach()

file(REMOVE_RECURSE "${CURRENT_PACKAGES_DIR}/debug/include")
file(REMOVE_RECURSE "${CURRENT_PACKAGES_DIR}/debug/share")

if (VCPKG_LIBRARY_LINKAGE MATCHES "static")
    file(REMOVE_RECURSE "${CURRENT_PACKAGES_DIR}/bin")
    file(REMOVE_RECURSE "${CURRENT_PACKAGES_DIR}/debug/bin")
endif()

file(COPY "${CMAKE_CURRENT_LIST_DIR}/usage" DESTINATION "${CURRENT_PACKAGES_DIR}/share/${PORT}")

vcpkg_install_copyright(FILE_LIST "${SOURCE_PATH}/LICENSE")
