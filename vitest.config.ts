/**
 * Vitest configuration for AI SDK Chat Kernel unit tests.
 * 
 * Unit tests run in Node.js environment and test individual functions.
 */

import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // Test directory
    include: ['tests/unit/**/*.test.ts'],
    
    // Environment
    environment: 'node',
    
    // Global test timeout
    testTimeout: 30000,
    
    // Coverage
    coverage: {
      provider: 'v8',
      reporter: ['text', 'json', 'html'],
      include: ['src/**/*.ts'],
      exclude: ['src/**/*.d.ts'],
    },
    
    // Type checking
    typecheck: {
      enabled: true,
    },
  },
});
