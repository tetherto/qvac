declare module 'b4a' {
  interface B4A {
    from(value: string, encoding: string): Buffer
    from(value: Uint8Array): Buffer
    toString(value: Uint8Array, encoding: string): string
  }

  const b4a: B4A
  export default b4a
}
