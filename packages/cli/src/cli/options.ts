/** Commander value collector for repeatable options. */
export function collect(value: string, previous: string[]): string[] {
  return previous.concat([value])
}
