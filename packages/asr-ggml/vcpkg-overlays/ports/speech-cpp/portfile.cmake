
set(VCPKG_POLICY_MISMATCHED_NUMBER_OF_BINARIES enabled)
set(VCPKG_BUILD_TYPE release)

vcpkg_from_github(
    OUT_SOURCE_PATH SOURCE_PATH
    REPO tetherto/qvac-fabric-speech.cpp
    REF ace2569fb84c11ce639a6c083e0ece041dc7b3cd
    SHA512 bb671f5c4d9b3f02d370a0fda08e9b460be43618d808bcf145951c487aa94b69c1e98bcd42a9332c5b2c9fce98f406bd75438958150ba4f100015212b427e56e
    HEAD_REF feat/add-nemotron-diarize
)

if (NOT EXISTS "${SOURCE_PATH}/CMakeLists.txt")
    message(FATAL_ERROR
        "speech-cpp: ${SOURCE_PATH}/CMakeLists.txt missing; the umbrella "
        "CMakeLists.txt at the qvac-fabric-speech.cpp repo root may have moved.")
endif()

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

if (NOT SPEECH_ENABLED_ENGINES)
    list(JOIN SPEECH_ENGINE_FEATURES ", " SPEECH_ENGINE_FEATURE_LIST)
    message(FATAL_ERROR
        "speech-cpp: no engine selected. Enable at least one of the engine "
        "features: ${SPEECH_ENGINE_FEATURE_LIST}.")
endif()

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
        -DWHISPER_USE_SYSTEM_GGML=ON
        -DPARAKEET_USE_SYSTEM_GGML=ON
        -DTTS_CPP_USE_SYSTEM_GGML=ON
        -DAUDIOGEN_USE_SYSTEM_GGML=ON
        -DWHISPER_BUILD_SERVER=OFF
        -DPARAKEET_BUILD_LIBRARY=ON
        -DPARAKEET_INSTALL=ON
        -DPARAKEET_OPENMP=OFF
        -DPARAKEET_CCACHE=OFF
        -DTTS_CPP_BUILD_LIBRARY=ON
        -DTTS_CPP_BUILD_SHARED=OFF
        -DTTS_CPP_INSTALL=ON
        -DTTS_CPP_OPENMP=OFF
        -DTTS_CPP_CCACHE=OFF
        -DAUDIOGEN_BUILD_LIBRARY=ON
        -DAUDIOGEN_INSTALL=ON
        -DAUDIOGEN_CCACHE=OFF
        -DGGML_NATIVE=OFF
        -DGGML_OPENMP=OFF
        -DGGML_CCACHE=OFF
        ${FEATURE_OPTIONS}
        ${PLATFORM_OPTIONS}
)

vcpkg_cmake_install()

if (SPEECH_BUILD_WHISPER)
    vcpkg_cmake_config_fixup(PACKAGE_NAME whisper CONFIG_PATH share/whisper)
endif()
if (SPEECH_BUILD_PARAKEET)
    vcpkg_cmake_config_fixup(PACKAGE_NAME qvac-parakeet CONFIG_PATH lib/cmake/qvac-parakeet)
endif()
if (SPEECH_BUILD_TTS)
    vcpkg_cmake_config_fixup(PACKAGE_NAME tts-cpp CONFIG_PATH share/tts-cpp)
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
