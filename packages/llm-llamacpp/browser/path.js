// POSIX subset of bare-path used by the addon's JS, for the browser build.
// Model paths there are OPFS paths, which always use `/`.

function isAbsolute(path) {
  return path.startsWith('/')
}

function basename(path) {
  const trimmed = path.replace(/\/+$/, '')
  return trimmed.slice(trimmed.lastIndexOf('/') + 1)
}

function join(...parts) {
  return parts
    .filter((part) => part !== '')
    .join('/')
    .replace(/\/{2,}/g, '/')
}

module.exports = { isAbsolute, basename, join, sep: '/' }
