// Mock <uv.h> for unit tests. The real libuv is not linked into the unit
// tests, but several headers (`JsLogger.hpp`, `OutputCallbackJs.hpp`) include
// <uv.h> directly. The opaque uv types and the no-op uv functions we need are
// already defined in our mock `js.h`, so this header just forwards there.

#pragma once

#include "js.h"
