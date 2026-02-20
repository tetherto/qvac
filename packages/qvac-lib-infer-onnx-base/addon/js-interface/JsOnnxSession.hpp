#pragma once

#include <js.h>

#include "OnnxSession.hpp"

namespace onnx_addon {
namespace js {

// Create a new ONNX session
// Args: modelPath (string), config (object, optional)
// Returns: external pointer to OnnxSession
js_value_t* createSession(js_env_t* env, js_callback_info_t* info);

// Destroy an ONNX session
// Args: session (external)
// Returns: undefined
js_value_t* destroySession(js_env_t* env, js_callback_info_t* info);

// Get input tensor info
// Args: session (external)
// Returns: array of {name, shape, type}
js_value_t* getInputInfo(js_env_t* env, js_callback_info_t* info);

// Get output tensor info
// Args: session (external)
// Returns: array of {name, shape, type}
js_value_t* getOutputInfo(js_env_t* env, js_callback_info_t* info);

// Run inference
// Args: session (external), inputs (array of {name, shape, type, data})
// Returns: array of {name, shape, type, data}
js_value_t* run(js_env_t* env, js_callback_info_t* info);

// Get cache statistics
// Args: none
// Returns: {sessionCount, sessions: [{key, modelPath, refCount}]}
js_value_t* getCacheStats(js_env_t* env, js_callback_info_t* info);

// Helper function to unwrap OnnxSession from JS external value
// Used internally by this addon
OnnxSession* unwrapSession(js_env_t* env, js_value_t* external);

}  // namespace js
}  // namespace onnx_addon
