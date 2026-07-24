// ChildSpec for a bare-stow worker: launch via the injected runner, stop by EOF, report exit as death.
module.exports = function stowChild(entry, opts = {}) {
  const { runner, args = [], logger = null, create = null, ...spec } = opts
  let current = null

  return {
    ...spec,
    async start({ onDeath }) {
      if (current) throw new Error('stowChild spec is single-use — one spec per child')
      const { ipc, exit } = runner(entry, args, logger)
      try {
        await Promise.race([
          ipc.ready,
          exit.then((code) => Promise.reject(new Error(`stow child exited (${code}) before ready`)))
        ])
        const handle = create ? await create(ipc) : ipc
        exit.then((code) => onDeath(new Error(`stow child exited (${code})`)))
        current = { ipc, exit }
        return handle
      } catch (err) {
        // a live child must not outlive a failed start — EOF it and await the real exit
        ipc.destroy()
        await exit
        throw err
      }
    },
    async stop(handle) {
      if (!current) return
      const { ipc, exit } = current
      current = null
      try {
        if (handle !== ipc && typeof handle.close === 'function') await handle.close()
      } finally {
        ipc.destroy()
        await exit // the stow contract: EOF → the child runs its stop() and exits; never killed
      }
    }
  }
}
