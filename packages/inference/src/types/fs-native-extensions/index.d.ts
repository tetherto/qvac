declare module 'fs-native-extensions' {
  const fsx: {
    /**
     * Returns `false` when another open file description holds a conflicting
     * lock. `shared: true` takes a shared lock instead of an exclusive one.
     */
    tryLock(fd: number, opts?: { shared?: boolean }): boolean
    /** Releases this descriptor's lock. */
    unlock(fd: number): void
  }
  export default fsx
}
