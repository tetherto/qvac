// Its own module, so the command logic that throws it loads without Core.
export class CommandError extends Error {
  code: number
  locked: boolean
  constructor(message: string | undefined, { code = 1, locked = false } = {}) {
    super(message)
    this.code = code
    this.locked = locked
  }
}
