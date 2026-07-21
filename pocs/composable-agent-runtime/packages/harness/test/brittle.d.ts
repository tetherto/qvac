declare module 'brittle' {
  interface TestContext {
    alike<T>(actual: T, expected: T, message?: string): void
    is<T>(actual: T, expected: T, message?: string): void
    ok(value: boolean, message?: string): void
    timeout(milliseconds: number): void
  }

  export default function test(
    name: string,
    body: (context: TestContext) => Promise<void> | void
  ): void
}
