/**
 * Prepares the engine to run in a browser Dedicated Worker. Await it once
 * before `initialize()`: it loads the index of the origin private file system
 * that backs the engine's file access.
 */
export { hydrate as prepareBrowserRuntime } from './fs'
