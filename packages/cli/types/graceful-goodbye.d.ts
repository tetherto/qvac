declare module 'graceful-goodbye' {
  function goodbye(handler: () => void | Promise<void>, position?: number): () => void
  namespace goodbye {
    function exit(): void
  }
  export default goodbye
}
