# The callback exits with a sentinel. A SIGABRT, crash, missing DLL, or a
# normal exit must not be mistaken for callback delivery.
execute_process(COMMAND "${PROGRAM}" abort "${MODULE}"
  RESULT_VARIABLE result OUTPUT_VARIABLE output ERROR_VARIABLE error TIMEOUT 20)
if(NOT "${result}" STREQUAL "86")
  message(FATAL_ERROR "Module abort did not reach caller callback (exit ${result})\n${output}\n${error}")
endif()
