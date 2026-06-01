'use strict'

// Duck-typed AbortController for unit tests. infer-base only touches
// `aborted` / `reason` / `addEventListener` / `removeEventListener`, so
// tests don't need a global `AbortController` (Bare lacks one) or a dep
// on `bare-abort-controller`.
function makeAbortable () {
  const listeners = new Set()
  const signal = {
    aborted: false,
    reason: undefined,
    addEventListener (event, cb, opts) {
      if (event !== 'abort') return
      const wrapped = opts && opts.once
        ? () => { listeners.delete(wrapped); cb() }
        : cb
      wrapped._original = cb
      listeners.add(wrapped)
    },
    removeEventListener (event, cb) {
      if (event !== 'abort') return
      for (const l of listeners) {
        if (l === cb || l._original === cb) {
          listeners.delete(l)
          return
        }
      }
    }
  }
  return {
    signal,
    abort (reason) {
      if (signal.aborted) return
      signal.aborted = true
      signal.reason = reason
      for (const l of Array.from(listeners)) l()
    }
  }
}

module.exports = { makeAbortable }
