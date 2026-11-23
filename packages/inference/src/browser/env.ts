// bare-env stand-in: the browser has no process environment. HOME maps the
// engine's ~/.qvac directory to the root of the origin private file system.
export default { HOME: '/' } as Record<string, string | undefined>
