declare module 'b4a' {
  interface B4A {
    from(value: string, encoding: string): Buffer
  }

  const b4a: B4A
  export default b4a
}
