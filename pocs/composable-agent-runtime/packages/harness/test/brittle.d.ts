declare module 'brittle' {
  interface TestContext {
    alike<T>(actual: T, expected: T, message?: string): boolean
    is<T>(actual: T, expected: T, message?: string): boolean
    ok(value: boolean, message?: string): boolean
    absent(value: unknown, message?: string): boolean
    exception<T>(promise: PromiseLike<T>, expected: RegExp): Promise<void>
    timeout(milliseconds: number): void
    teardown(callback: () => unknown): void
  }

  export default function test(
    name: string,
    body: (context: TestContext) => Promise<void> | void
  ): void
}
