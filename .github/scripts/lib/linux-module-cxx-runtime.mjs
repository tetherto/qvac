/**
 * Decide whether a Linux prebuild depends on a C++ runtime the loading process
 * may not have.
 *
 * Prebuilds link libc++ statically and are dlopen'd by hosts that need not map
 * any C++ runtime (bare-sidecar maps none). A NEEDED shared C++ runtime, or a
 * C++ runtime symbol left undefined, makes a module load only in some
 * processes, and a GPU backend that fails to load falls back to CPU silently.
 *
 * The same rule runs in qvac-registry-vcpkg's qvac-fabric port
 * (qvac-check-cxx-runtime.cmake); keep the two in step.
 */

'use strict'

export const FORBIDDEN_NEEDED = /^lib(stdc\+\+|c\+\+|c\+\+abi)\.so/

// glibc provides these, and libgcc_s the _Unwind_* symbols, which no pattern
// below matches.
export const ALLOWED_SYMBOLS = /^__cxa_(atexit|finalize|thread_atexit_impl)$/

export const FORBIDDEN_SYMBOLS = [
  // std:: names, both libstdc++'s and libc++'s inline std::__1, and the std
  // abbreviations (std::allocator, basic_string, string, istream, ostream,
  // iostream)
  /^_ZN?K?St/,
  /^_ZNK?S[abiosd]/,
  // typeinfo, vtables and typeinfo names of std and cxxabi types
  /^_ZT[IVS]N?K?S[tabiosd]/,
  /^_ZT[IVS]N10__cxxabiv1/,
  // operator new and delete
  /^_Zn[wa]/,
  /^_Zd[la]/,
  /^__cxa_/,
  /^__gxx_personality_/,
  /^__dynamic_cast$/,
]

/** NEEDED entries from `readelf -d` (GNU or LLVM). */
export function parseNeeded(readelfOutput) {
  return [...readelfOutput.matchAll(/\(NEEDED\)[^\n[]*\[([^\]\n]+)\]/g)].map((match) => match[1])
}

/** Symbol names, without version suffixes, from `nm -D --undefined-only -P`. */
export function parseUndefined(nmOutput) {
  return nmOutput
    .split('\n')
    .map((line) => line.trim().split(/[@ ]/)[0])
    .filter(Boolean)
}

export function isForbiddenSymbol(symbol) {
  if (ALLOWED_SYMBOLS.test(symbol)) return false
  return FORBIDDEN_SYMBOLS.some((pattern) => pattern.test(symbol))
}

export function cxxRuntimeViolations({ needed, undefinedSymbols }) {
  return {
    needed: needed.filter((lib) => FORBIDDEN_NEEDED.test(lib)),
    symbols: undefinedSymbols.filter(isForbiddenSymbol),
  }
}

export function formatViolations(file, { needed, symbols }, shown = 10) {
  const lines = [file]
  if (needed.length > 0) lines.push(`  NEEDED: ${needed.join(', ')}`)
  if (symbols.length > 0) {
    lines.push(`  ${symbols.length} undefined C++ runtime symbols, first:`)
    for (const symbol of symbols.slice(0, shown)) lines.push(`    ${symbol}`)
  }
  return lines.join('\n')
}
