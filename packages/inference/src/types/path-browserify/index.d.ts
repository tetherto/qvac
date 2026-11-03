declare module 'path-browserify' {
  import type path from 'bare-path'
  const posix: typeof path
  export default posix
}
