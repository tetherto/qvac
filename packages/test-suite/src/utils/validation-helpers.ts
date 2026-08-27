import type { Expectation } from '../types/test-definition.js'
import type { TestResult } from '../core/consumer-base.js'

/**
 * Compose multiple expectations with AND logic.
 * Returns a function expectation that runs each in order,
 * returning the first failure or a combined success.
 */
export function chainExpectation(...expectations: Expectation[]): Expectation {
  return {
    validation: 'function' as const,
    fn(result: unknown): TestResult {
      const outputs: string[] = []
      for (const expectation of expectations) {
        const r = ValidationHelpers.validate(result, expectation)
        if (!r.passed) {
          return { passed: false, output: `[${expectation.validation}] ${r.output}` }
        }
        outputs.push(r.output)
      }
      return { passed: true, output: outputs.join(' | ') }
    }
  }
}

/**
 * Validation helpers for common test expectations
 */
export class ValidationHelpers {
  /**
   * Validate a result against an expectation
   * Accepts any expectation type for flexibility
   */
  static validate<T extends Expectation = Expectation>(
    result: unknown,
    expectation: T
  ): TestResult {
    try {
      switch (expectation.validation) {
        case 'contains-all':
          return this.validateContainsAll(result, expectation.contains)

        case 'contains-any':
          return this.validateContainsAny(result, expectation.contains)

        case 'regex':
          return this.validateRegex(result, expectation.pattern)

        case 'numeric-range':
          return this.validateNumericRange(result, expectation.min, expectation.max)

        case 'type':
          return this.validateType(result, expectation.expectedType, expectation.minLength)

        case 'throws-error':
          return this.validateThrowsError(result, expectation.errorContains)

        case 'function':
          return this.validateFunction(result, expectation.fn)

        default:
          return {
            passed: false,
            output: `Unknown validation type: ${(expectation as { validation?: string }).validation}`
          }
      }
    } catch (error: unknown) {
      const errorMessage = error instanceof Error ? error.message : String(error)
      return {
        passed: false,
        output: `Validation error: ${errorMessage}`
      }
    }
  }

  private static validateContainsAll(result: unknown, contains: string[]): TestResult {
    const text = String(result).toLowerCase()
    const missing = contains.filter((str) => !text.includes(str.toLowerCase()))

    if (missing.length === 0) {
      return { passed: true, output: text }
    }

    return {
      passed: false,
      output: `Missing required strings: ${missing.join(', ')}. Got: ${text.substring(0, 200)}`
    }
  }

  private static validateContainsAny(result: unknown, contains: string[]): TestResult {
    const text = String(result).toLowerCase()
    const found = contains.find((str) => text.includes(str.toLowerCase()))

    if (found) {
      return { passed: true, output: text }
    }

    return {
      passed: false,
      output: `None of the required strings found: ${contains.join(', ')}. Got: ${text.substring(0, 200)}`
    }
  }

  private static validateRegex(result: unknown, pattern: string): TestResult {
    const text = String(result)
    const regex = new RegExp(pattern)

    if (regex.test(text)) {
      return { passed: true, output: text }
    }

    return {
      passed: false,
      output: `Text does not match pattern ${pattern}. Got: ${text.substring(0, 200)}`
    }
  }

  private static validateNumericRange(result: unknown, min?: number, max?: number): TestResult {
    const num = typeof result === 'number' ? result : Number(result)

    if (isNaN(num)) {
      return {
        passed: false,
        output: `Expected number, got: ${String(result)}`
      }
    }

    if (min !== undefined && num < min) {
      return {
        passed: false,
        output: `Value ${num} is below minimum ${min}`
      }
    }

    if (max !== undefined && num > max) {
      return {
        passed: false,
        output: `Value ${num} is above maximum ${max}`
      }
    }

    return { passed: true, output: String(num) }
  }

  private static validateType(
    result: unknown,
    expectedType: string,
    minLength?: number
  ): TestResult {
    const actualType = Array.isArray(result) ? 'array' : typeof result

    if (actualType !== expectedType) {
      return {
        passed: false,
        output: `Expected ${expectedType}, got ${actualType}`
      }
    }

    if (
      expectedType === 'array' &&
      minLength &&
      Array.isArray(result) &&
      result.length < minLength
    ) {
      return {
        passed: false,
        output: `Array has ${result.length} elements, expected at least ${minLength}`
      }
    }

    return {
      passed: true,
      output:
        expectedType === 'array' && Array.isArray(result)
          ? `Array with ${result.length} elements`
          : `Type ${actualType} matches`
    }
  }

  private static validateThrowsError(result: unknown, errorContains: string): TestResult {
    const text = String(result).toLowerCase()

    if (text.includes(errorContains.toLowerCase())) {
      return {
        passed: true,
        output: `Error contains expected text: ${errorContains}`
      }
    }

    return {
      passed: false,
      output: `Error does not contain "${errorContains}". Got: ${String(result).substring(0, 200)}`
    }
  }

  private static validateFunction(
    result: unknown,
    fn: (result: unknown) => TestResult
  ): TestResult {
    try {
      return fn(result)
    } catch (error: unknown) {
      const errorMessage = error instanceof Error ? error.message : String(error)
      return {
        passed: false,
        output: `Function validator threw error: ${errorMessage}`
      }
    }
  }
}
