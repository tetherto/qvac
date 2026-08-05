declare module 'brittle' {
  interface TestContext {
    alike<T>(actual: T, expected: T, message?: string): void
    is<T>(actual: T, expected: T, message?: string): void
    ok(value: unknown, message?: string): void
    exception<T>(
      operation: PromiseLike<T> | (() => T),
      expected: RegExp
    ): Promise<void> | void
  }

  export default function test(
    name: string,
    body: (context: TestContext) => Promise<void> | void
  ): void
}
