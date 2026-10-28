// bare-path stand-in: POSIX paths, which is what the browser file system uses.
import path from 'path-browserify'

// path-browserify resolves relative paths against process.cwd(), which a
// worker does not have; the browser build's working directory is `/`.
export default {
  ...path,
  resolve: (...paths: string[]): string => path.resolve('/', ...paths)
}
