/**
 * Jest config for HAOps MCP Server contract tests.
 *
 * Contract tests call HAOps API endpoints directly (same as MCP tool handlers)
 * and snapshot response shapes to detect API drift.
 *
 * Requirements: HAOps running at HAOPS_API_URL + valid HAOPS_API_KEY.
 * If HAOps is down or key missing, all tests skip gracefully.
 */

export default {
  preset: 'ts-jest/presets/default-esm',
  testEnvironment: 'node',
  testTimeout: 30000,
  extensionsToTreatAsEsm: ['.ts'],
  moduleNameMapper: {
    '^(\\.{1,2}/.*)\\.js$': '$1',
  },
  transform: {
    '^.+\\.tsx?$': [
      'ts-jest',
      {
        useESM: true,
        diagnostics: {
          ignoreCodes: [151002],
        },
        tsconfig: {
          module: 'Node16',
          moduleResolution: 'Node16',
          target: 'ES2022',
          esModuleInterop: true,
          skipLibCheck: true,
          strict: false,
        },
      },
    ],
  },
  testMatch: ['**/tests/contracts/**/*.test.ts'],
  snapshotResolver: undefined,
};
