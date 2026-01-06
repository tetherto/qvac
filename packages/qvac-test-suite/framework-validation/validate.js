#!/usr/bin/env node
/**
 * Step 1 Validation: Config and Test Loading
 *
 * Verifies that the framework can:
 * - Load configuration from qvac-test.config.js
 * - Load test definitions from testDir
 * - Parse and validate test structure
 */

import { loadConfig } from '../framework/dist/utils/config-loader.js';
import { loadTests } from '../framework/dist/utils/test-loader.js';

async function validate() {
  try {
    console.log('🔍 Step 1 Validation: Config and Test Loading\n');

    // Load config
    console.log('Loading config from framework-validation/...');
    const config = await loadConfig('.');
    console.log('✅ Config loaded successfully');
    console.log('   - brokerUrl:', config.brokerUrl);
    console.log('   - testDir:', config.testDir);
    console.log('   - consumers:', Object.keys(config.consumers).join(', '));

    // Load tests
    console.log('\nLoading tests from', config.testDir, '...');
    const tests = await loadTests(config, '.');
    console.log('✅ Tests loaded successfully');
    console.log('   - Count:', tests.length);

    // Show test details
    console.log('\nTest Details:');
    tests.forEach((test, idx) => {
      console.log(`   ${idx + 1}. ${test.testId}`);
      console.log(`      - validation: ${test.expectation.validation}`);
      console.log(`      - metadata:`, test.metadata || 'none');
    });

    console.log('\n✅ Step 1 VALIDATED: Config and test loading working!\n');
  } catch (error) {
    console.error('\n❌ Validation failed:', error.message);
    process.exit(1);
  }
}

validate();
