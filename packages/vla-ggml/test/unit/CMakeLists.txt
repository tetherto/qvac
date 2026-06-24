find_package(GTest CONFIG REQUIRED)

add_executable(
  addon-test
  test_hparams.cpp
  test_backend_selection.cpp
  test_model_factory.cpp
  test_pi05_m3_1_siglip.cpp
  test_pi05_m3_2_siglip_block.cpp
  test_pi05_m3_3_siglip_tower.cpp
  test_pi05_m3_4_vlm_embed.cpp
  test_pi05_m3_5_vlm_block.cpp
  test_pi05_m3_6_vlm_prefill.cpp
  test_pi05_m3_7_time_cond.cpp
  test_pi05_m3_8_adarms_split.cpp
  test_pi05_m3_9_expert_block.cpp
  test_pi05_m3_10_expert_full.cpp
  test_pi05_m3_11_euler_step.cpp
  test_pi05_m3_12_ode_loop.cpp
  test_pi05_m3_13_end_to_end.cpp
  test_pi05_integration.cpp
  backend_env.cpp
  ${CMAKE_SOURCE_DIR}/addon/src/model-interface/smolvla.cpp
  ${CMAKE_SOURCE_DIR}/addon/src/model-interface/smolvla_adapter.cpp
  ${CMAKE_SOURCE_DIR}/addon/src/model-interface/pi05.cpp
  ${CMAKE_SOURCE_DIR}/addon/src/model-interface/model_factory.cpp
  ${CMAKE_SOURCE_DIR}/addon/src/utils/BackendSelection.cpp
  ${CMAKE_SOURCE_DIR}/addon/src/utils/LoggingMacros.cpp
)

target_compile_options(
  addon-test
  PRIVATE
    -Wno-deprecated
    -Wfatal-errors
    -g)

target_include_directories(
  addon-test
  PRIVATE
    ${CMAKE_SOURCE_DIR}/addon/src
    ${QVAC_LIB_INFERENCE_ADDON_CPP_INCLUDE_DIRS}
)

target_compile_features(addon-test PRIVATE cxx_std_20)

# Under GGML_BACKEND_DL the CPU/GPU backends are separate libqvac-ggml-*.so
# modules co-installed with the ggml core lib. Production loads them from the
# addon's prebuilds dir; the unit-test env (backend_env.cpp) loads them from
# here. There's no reliable runtime handle to that directory ($ORIGIN RUNPATH
# leaves dladdr with a relative path), so pass the absolute ggml lib dir in.
target_compile_definitions(
  addon-test
  PRIVATE GGML_BACKEND_DIR="$<TARGET_FILE_DIR:ggml::ggml>")

target_link_libraries(
  addon-test
  PRIVATE
    ggml::ggml
    GTest::gtest
    GTest::gtest_main
    GTest::gmock_main
)

add_test(NAME VlaGgmlUnit COMMAND addon-test)
set_tests_properties(VlaGgmlUnit PROPERTIES
  WORKING_DIRECTORY ${CMAKE_SOURCE_DIR}
  TIMEOUT 900)
