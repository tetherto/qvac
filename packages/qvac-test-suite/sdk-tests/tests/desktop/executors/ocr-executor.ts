// OCR executor
import { ocr } from '@qvac/sdk';
import * as path from 'node:path';
import { ValidationHelpers, type TestResult, type Expectation } from '@tetherto/qvac-test-suite';
import { ocrTests } from '../../ocr-tests.js';
import { ModelManager } from '../model-manager.js';

export class OcrExecutor {
  pattern = /^ocr-/;

  // All OCR tests use handlers based on test configuration
  handlers = Object.fromEntries(
    ocrTests.map((test) => {
      const params = test.params as { streaming?: boolean };
      if (params.streaming) {
        return [test.testId, this.streaming];
      }
      return [test.testId, this.generic];
    })
  );

  async execute(testId: string, context: unknown, params: unknown, expectation: unknown): Promise<TestResult> {
    const handler = this.handlers[testId];
    if (handler) {
      return await (handler as (params: unknown, expectation: unknown) => Promise<TestResult>).call(
        this,
        params,
        expectation
      );
    }
    return { passed: false, output: `Unknown test: ${testId}` };
  }

  async generic(params: unknown, expectation: unknown): Promise<TestResult> {
    const p = params as { imageFileName: string; paragraph?: boolean; timeout?: number };
    const ocrModelId = await ModelManager.getOcrModel();

    // Get image file path (resolve from current working directory up to repo root)
    const imagePath = path.resolve(process.cwd(), '../shared-test-data/images', p.imageFileName);

    try {
      const { blocks } = ocr({
        modelId: ocrModelId,
        image: imagePath,
        options: p.paragraph ? { paragraph: true } : undefined,
      });

      const result = await blocks;

      // Extract text from all blocks for validation
      const allText = result.map((block) => block.text).join(' ');

      // For contains validations, use the concatenated text
      // For type validations, return the array
      const exp = expectation as Expectation;
      if (exp.validation === 'contains-all' || exp.validation === 'contains-any') {
        return ValidationHelpers.validate(allText, exp);
      }

      // For type validation, validate against the array
      return ValidationHelpers.validate(result, exp);
    } catch (error) {
      const errorMsg = error instanceof Error ? error.message : String(error);
      return { passed: false, output: `OCR failed: ${errorMsg}` };
    }
  }

  async streaming(params: unknown, expectation: unknown): Promise<TestResult> {
    const p = params as { imageFileName: string; paragraph?: boolean; timeout?: number };
    const ocrModelId = await ModelManager.getOcrModel();

    // Get image file path
    const imagePath = path.resolve(process.cwd(), '../shared-test-data/images', p.imageFileName);

    try {
      const { blockStream } = ocr({
        modelId: ocrModelId,
        image: imagePath,
        stream: true,
        options: p.paragraph ? { paragraph: true } : undefined,
      });

      const allBlocks: Array<{ text: string; bbox?: [number, number, number, number]; confidence?: number }> = [];

      for await (const blocks of blockStream) {
        allBlocks.push(...blocks);
      }

      return ValidationHelpers.validate(allBlocks, expectation as Expectation);
    } catch (error) {
      const errorMsg = error instanceof Error ? error.message : String(error);
      return { passed: false, output: `OCR streaming failed: ${errorMsg}` };
    }
  }
}

