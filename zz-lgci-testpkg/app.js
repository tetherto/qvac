// Throwaway JS-only fixture for PR #2873 detection validation.
// A synchronize push touching only this file must report native_changed=false
// under the per-push delta (before..head sees only JS). Delete with sandbox.
module.exports = function lgciJsMarker () { return 1 }
