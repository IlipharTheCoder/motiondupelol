import { defineConfig } from 'vitest/config';

// Deliberately separate from vite.config.ts — the @crxjs/vite-plugin manifest
// processing has no role in running unit tests and isn't worth entangling
// with the test runner. Default environment is plain `node` (fast); the one
// DOM-touching suite (lib/anchorFinder.test.ts) opts into jsdom per-file via
// a `// @vitest-environment jsdom` docblock rather than paying the jsdom
// cost for every test in the suite.
export default defineConfig({
  test: {
    environment: 'node',
  },
});
