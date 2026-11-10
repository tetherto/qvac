declare module 'bare-tui' {
  interface Program {
    input: { destroy(): void }
    output: { write(text: string): unknown }
    _decoder?: { _escapeDelay: number }
    send(message: unknown): void
    repaint(): void
    run(): Promise<void>
  }
  const tui: import('./app-types.js').Tui & {
    Program: new (
      model: {
        view(): string
        update(msg: { type: string }): [unknown, import('./app-types.js').Command]
      },
      options: { mouse: boolean | 'drag' }
    ) => Program
    key: { matches(msg: unknown, ...names: string[]): boolean }
  }
  export default tui
}
declare module 'bare-tui-updater' {
  const widget: {
    create(options: {
      onAccept(): unknown
      acceptKey: string
    }): import('./app-types.js').UpdateBanner
  }
  export default widget
}
declare module 'bare-tui-updater/pear' {
  const pear: {
    wire(
      widget: import('./app-types.js').UpdateBanner | null,
      options: { updater: unknown; send(msg: unknown): void }
    ): () => void
  }
  export default pear
}
