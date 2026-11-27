// Release MSVC runtime DLLs ship beside the addon; modern Windows provides UCRT.
// Preserve the separate GPU-loader checks in the callers.
function windowsRuntimeViolations(imports, packagedFiles) {
  const available = new Set(packagedFiles.map((name) => name.toLowerCase()))
  return imports.flatMap((name) => {
    const redistributable = /^(vcruntime|msvcp|concrt)\d\w*\.dll$/i.test(name)
    const supported = /^(vcruntime|msvcp|concrt)140(?:_\w+)?\.dll$/i.test(name)
    if (
      /^(vcruntime|msvcp|concrt)\d\w*d\.dll$|^ucrtbased\.dll$|^msvcr\d.*\.dll$/i.test(name) ||
      (redistributable && !supported)
    ) {
      return [`unsupported Debug/legacy runtime ${name}`]
    }
    if (redistributable && !available.has(name.toLowerCase())) {
      return [`missing packaged runtime ${name}`]
    }
    return []
  })
}

module.exports = { windowsRuntimeViolations }
