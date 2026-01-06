import type { Expectation } from '../types/test-definition.js';
import type { TestResult } from '../core/consumer-base.js';

/**
 * Validation helpers for common test expectations
 */
export class ValidationHelpers {
  /**
   * Validate a result against an expectation
   * Accepts any expectation type for flexibility
   */
  static validate<T extends Expectation = Expectation>(result: unknown, expectation: T): TestResult {
    try {
      switch (expectation.validation) {
        case 'contains-all':
          return this.validateContainsAll(result, expectation.contains);

        case 'contains-any':
          return this.validateContainsAny(result, expectation.contains);

        case 'regex':
          return this.validateRegex(result, expectation.pattern);

        case 'numeric-range':
          return this.validateNumericRange(result, expectation.min, expectation.max);

        case 'type':
          return this.validateType(result, expectation.expectedType, expectation.minDimensions);

        case 'throws-error':
          return this.validateThrowsError(result, expectation.errorContains);

        case 'custom':
          return this.validateCustom(result, expectation.validator);

        default:
          return {
            passed: false,
            output: `Unknown validation type: ${(expectation as { validation?: string }).validation}`,
          };
      }
    } catch (error: unknown) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      return {
        passed: false,
        output: `Validation error: ${errorMessage}`,
      };
    }
  }

  private static validateContainsAll(result: unknown, contains: string[]): TestResult {
    const text = String(result).toLowerCase();
    const missing = contains.filter((str) => !text.includes(str.toLowerCase()));

    if (missing.length === 0) {
      return { passed: true, output: text };
    }

    return {
      passed: false,
      output: `Missing required strings: ${missing.join(', ')}. Got: ${text.substring(0, 200)}`,
    };
  }

  private static validateContainsAny(result: unknown, contains: string[]): TestResult {
    const text = String(result).toLowerCase();
    const found = contains.find((str) => text.includes(str.toLowerCase()));

    if (found) {
      return { passed: true, output: text };
    }

    return {
      passed: false,
      output: `None of the required strings found: ${contains.join(', ')}. Got: ${text.substring(0, 200)}`,
    };
  }

  private static validateRegex(result: unknown, pattern: string): TestResult {
    const text = String(result);
    const regex = new RegExp(pattern);

    if (regex.test(text)) {
      return { passed: true, output: text };
    }

    return {
      passed: false,
      output: `Text does not match pattern ${pattern}. Got: ${text.substring(0, 200)}`,
    };
  }

  private static validateNumericRange(result: unknown, min?: number, max?: number): TestResult {
    const num = typeof result === 'number' ? result : Number(result);

    if (isNaN(num)) {
      return {
        passed: false,
        output: `Expected number, got: ${String(result)}`,
      };
    }

    if (min !== undefined && num < min) {
      return {
        passed: false,
        output: `Value ${num} is below minimum ${min}`,
      };
    }

    if (max !== undefined && num > max) {
      return {
        passed: false,
        output: `Value ${num} is above maximum ${max}`,
      };
    }

    return { passed: true, output: String(num) };
  }

  private static validateType(result: unknown, expectedType: string, minDimensions?: number): TestResult {
    const actualType = Array.isArray(result) ? 'array' : typeof result;

    if (expectedType === 'embedding') {
      if (!Array.isArray(result)) {
        return {
          passed: false,
          output: `Expected embedding (array), got ${actualType}`,
        };
      }

      if (minDimensions && result.length < minDimensions) {
        return {
          passed: false,
          output: `Embedding has ${result.length} dimensions, expected at least ${minDimensions}`,
        };
      }

      return {
        passed: true,
        output: `Embedding with ${result.length} dimensions`,
      };
    }

    if (actualType !== expectedType) {
      return {
        passed: false,
        output: `Expected ${expectedType}, got ${actualType}`,
      };
    }

    return {
      passed: true,
      output: `Type ${actualType} matches`,
    };
  }

  private static validateThrowsError(result: unknown, errorContains: string): TestResult {
    const text = String(result).toLowerCase();

    if (text.includes(errorContains.toLowerCase())) {
      return {
        passed: true,
        output: `Error contains expected text: ${errorContains}`,
      };
    }

    return {
      passed: false,
      output: `Error does not contain "${errorContains}". Got: ${String(result).substring(0, 200)}`,
    };
  }

  private static validateCustom(result: unknown, validator: (result: unknown) => boolean): TestResult {
    try {
      const passed = validator(result);
      return {
        passed,
        output: passed ? String(result) : `Custom validation failed for: ${String(result).substring(0, 200)}`,
      };
    } catch (error: unknown) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      return {
        passed: false,
        output: `Custom validator threw error: ${errorMessage}`,
      };
    }
  }
}
