declare module 'fs-native-extensions' {
  const fsx: {
    /** Returns `false` when another open file description holds a conflicting lock. */
    tryLock(fd: number): boolean
  }
  export default fsx
}
