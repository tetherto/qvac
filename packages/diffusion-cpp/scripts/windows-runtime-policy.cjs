// Release MSVC runtime DLLs ship beside the addon; modern Windows provides UCRT.
// Preserve the separate GPU-loader checks in the callers.
function windowsRuntimeViolations(imports, packagedFiles) {
  const available = new Set(packagedFiles.map((name) => name.toLowerCase()))
  return imports.flatMap((name) => {
    if (/^(vcruntime|msvcp|concrt)\d\w*d\.dll$|^ucrtbased\.dll$|^msvcr\d.*\.dll$/i.test(name)) {
      return [`unsupported Debug/legacy runtime ${name}`]
    }
    if (/^(vcruntime|msvcp|concrt)\d\w*\.dll$/i.test(name) && !available.has(name.toLowerCase())) {
      return [`missing packaged runtime ${name}`]
    }
    return []
  })
}

module.exports = { windowsRuntimeViolations }
